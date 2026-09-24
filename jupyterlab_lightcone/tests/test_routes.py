"""Exercise paper cache safety and the authenticated Jupyter HTTP contract."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from astra.papers.cache import PaperCache
from tornado.web import HTTPError

from jupyterlab_lightcone import routes


DOI = "10.48550/arxiv.0812.2905"
ENDPOINT = ("jupyterlab_lightcone", "api", "papers")
PDF = b"%PDF-1.7\nexample cached paper\n%%EOF\n"


@pytest.fixture
def jp_base_url():
    """Exercise routing behind a JupyterHub-style URL prefix."""
    return "/user/researcher/"


@pytest.fixture(autouse=True)
def paper_cache(tmp_path, monkeypatch):
    """Isolate every test from the user's actual paper cache."""
    cache = tmp_path / "papers"
    cache.mkdir()
    monkeypatch.setenv("LIGHTCONE_PAPER_CACHE_DIR", str(cache))
    return cache


def write_paper(cache: Path, name="paper", **metadata) -> Path:
    """Create a real ASTRA cache entry, with controllable ordering for index tests."""
    paper = PaperCache(cache).add(
        metadata.pop("doi", DOI),
        PDF,
        title="Example paper",
        authors=["A. Researcher", "B. Scientist"],
        source_url="https://example.org/paper.pdf",
        **metadata,
    )
    directory = cache / name
    paper.pdf_path.parent.rename(directory)
    return directory


@pytest.fixture
def download(monkeypatch, paper_cache):
    """Replace the external downloader while retaining real cache reads/writes."""
    def save(doi, *, cache_dir):
        assert doi == "10.48550/arXiv.0812.2905"
        assert cache_dir == paper_cache
        directory = write_paper(cache_dir, doi=doi)
        return directory / "paper.pdf", SimpleNamespace(success=True, error=None)

    mocked = Mock(side_effect=save)
    monkeypatch.setattr(routes, "download_paper_to_cache", mocked)
    return mocked


def test_prefers_unversioned_papers(paper_cache):
    write_paper(paper_cache, "a-versioned", version=2)
    expected = write_paper(paper_cache, "z-unversioned")
    cached = routes.find_cached_paper(f"https://doi.org/{DOI.upper()}", paper_cache)
    assert cached is not None
    assert cached.pdf_path == expected / "paper.pdf"
    assert list(routes.cached_paper_index(paper_cache)) == [DOI]


@pytest.mark.parametrize("filename", ["paper.pdf", "meta.json"])
def test_rejects_symlinks_outside_cache(paper_cache, tmp_path, filename):
    directory = write_paper(paper_cache)
    source = directory / filename
    outside = tmp_path / filename
    source.rename(outside)
    source.symlink_to(outside)
    assert routes.cached_paper_index(paper_cache) == {}


@pytest.mark.parametrize("metadata", ["null", "[]", '"string"', "{", '{"doi": 3}'])
def test_skips_invalid_cache_metadata(paper_cache, metadata):
    directory = write_paper(paper_cache)
    (directory / "meta.json").write_text(metadata, encoding="utf-8")
    assert routes.cached_paper_index(paper_cache) == {}


@pytest.mark.parametrize("doi", ["../../etc/passwd", "10.1234/has space", "10.1234/a\x00b", "10.1234/" + "x" * 512])
def test_rejects_invalid_dois(doi):
    with pytest.raises(HTTPError, match="A valid DOI is required"):
        routes.validate_doi(doi)


def test_the_cache_is_astras_unless_the_server_names_another(monkeypatch):
    monkeypatch.setenv("LIGHTCONE_PAPER_CACHE_DIR", "/srv/lightcone-papers")
    assert routes.paper_cache_root() == Path("/srv/lightcone-papers")
    monkeypatch.delenv("LIGHTCONE_PAPER_CACHE_DIR")
    assert routes.paper_cache_root() == Path.home() / ".cache" / "astra" / "papers"


async def test_returns_only_requested_cached_metadata(jp_fetch, paper_cache):
    write_paper(paper_cache)
    response = await jp_fetch(
        *ENDPOINT,
        params=[("doi", f"https://doi.org/{DOI.upper()}"), ("doi", "10.1234/missing")],
    )
    assert response.code == 200
    assert json.loads(response.body) == {
        "papers": {
            DOI: {
                "doi": DOI,
                "title": "Example paper",
                "authors": "A. Researcher, B. Scientist",
            }
        }
    }
    assert response.headers["Cache-Control"] == "private, no-store"


async def test_empty_lookup(jp_fetch):
    response = await jp_fetch(*ENDPOINT)
    assert json.loads(response.body) == {"papers": {}}


async def test_bounds_lookup_size(jp_fetch):
    response = await jp_fetch(
        *ENDPOINT,
        params=[("doi", DOI)] * 201,
        raise_error=False,
    )
    assert response.code == 400


async def test_streams_authenticated_pdf(jp_fetch, paper_cache, monkeypatch):
    write_paper(paper_cache)
    monkeypatch.setattr(routes, "PDF_CHUNK_SIZE", 6)
    response = await jp_fetch(*ENDPOINT, "pdf", params={"doi": DOI})
    assert response.code == 200
    assert response.body == PDF
    assert response.headers["Content-Type"] == "application/pdf"
    assert response.headers["Content-Length"] == str(len(PDF))
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["Cache-Control"] == "private, no-store"


async def test_missing_pdf(jp_fetch):
    response = await jp_fetch(*ENDPOINT, "pdf", params={"doi": DOI}, raise_error=False)
    assert response.code == 404


async def test_rejects_non_pdf_cache_bytes(jp_fetch, paper_cache):
    directory = write_paper(paper_cache)
    (directory / "paper.pdf").write_bytes(b"<html>not a PDF</html>")
    response = await jp_fetch(*ENDPOINT, "pdf", params={"doi": DOI}, raise_error=False)
    assert response.code == 422


@pytest.mark.parametrize("body", [None, [], {}, {"doi": 3}, {"doi": "../secret"}])
async def test_rejects_invalid_fetch_body(jp_fetch, body):
    response = await jp_fetch(
        *ENDPOINT, "fetch", method="POST", body=json.dumps(body), raise_error=False
    )
    assert response.code == 400


async def test_fetches_missing_paper_once_for_concurrent_requests(jp_fetch, download):
    responses = await asyncio.gather(
        jp_fetch(*ENDPOINT, "fetch", method="POST", body=json.dumps({"doi": DOI})),
        jp_fetch(*ENDPOINT, "fetch", method="POST", body=json.dumps({"doi": DOI})),
    )
    assert all(response.code == 200 for response in responses)
    assert all(json.loads(response.body)["paper"]["doi"] == DOI for response in responses)
    download.assert_called_once()


@pytest.mark.parametrize(
    "failure", [RuntimeError("/private/cache/path"), OSError("/private/cache/path is read-only")]
)
async def test_fetch_failures_do_not_leak_server_details(jp_fetch, monkeypatch, failure):
    """A failed download or cache write is the upstream's failure; the details stay in the server log."""
    monkeypatch.setattr(routes, "fetch_cached_paper", Mock(side_effect=failure))
    response = await jp_fetch(
        *ENDPOINT,
        "fetch",
        method="POST",
        body=json.dumps({"doi": DOI}),
        raise_error=False,
    )
    assert response.code == 502
    assert b"/private/cache/path" not in response.body


async def test_a_defect_while_fetching_is_reported_as_one(jp_fetch, monkeypatch):
    monkeypatch.setattr(routes, "fetch_cached_paper", Mock(side_effect=TypeError("a bug")))
    response = await jp_fetch(
        *ENDPOINT, "fetch", method="POST", body=json.dumps({"doi": DOI}), raise_error=False
    )
    assert response.code == 500


@pytest.mark.parametrize(("action", "method"), [(None, "GET"), ("pdf", "GET"), ("fetch", "POST")])
async def test_requires_authentication(jp_fetch, action, method):
    response = await jp_fetch(
        *ENDPOINT,
        *([action] if action else []),
        params={"doi": DOI},
        method=method,
        body=json.dumps({"doi": DOI}) if method == "POST" else None,
        headers={"Authorization": ""},
        follow_redirects=False,
        raise_error=False,
    )
    assert response.code in (302, 403)


@pytest.mark.parametrize(("action", "method", "permission"), [(None, "GET", "read"), ("pdf", "GET", "read"), ("fetch", "POST", "write")])
async def test_requires_contents_authorization(jp_fetch, jp_serverapp, monkeypatch, action, method, permission):
    authorize = Mock(return_value=False)
    monkeypatch.setattr(jp_serverapp.authorizer, "is_authorized", authorize)
    response = await jp_fetch(
        *ENDPOINT,
        *([action] if action else []),
        params={"doi": DOI},
        method=method,
        body=json.dumps({"doi": DOI}) if method == "POST" else None,
        raise_error=False,
    )
    assert response.code == 403
    assert authorize.call_args.args[2:] == (permission, "contents")
