"""Authenticated paper-cache endpoints for Lightcone Lab's ASTRA integration."""

from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path

from jupyter_server.auth import authorized
from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join
from tornado import web
from tornado.iostream import StreamClosedError


DOI_PATTERN = re.compile(r"10\.\d{4,9}/[^\s\x00-\x1f\x7f]+", re.IGNORECASE)
PDF_CHUNK_SIZE = 1024 * 1024
MAX_LOOKUP_DOIS = 200
CachedPaper = tuple[Path, dict[str, object]]


def normalize_doi(value: str) -> str:
    """Normalize DOI links and identifiers for case-insensitive cache lookup."""
    normalized = value.strip()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:"):
        if normalized.lower().startswith(prefix):
            normalized = normalized[len(prefix) :]
            break
    return normalized.strip().lower()


def validate_doi(value: str) -> str:
    """Return a normalized DOI, rejecting malformed or excessive input."""
    normalized = normalize_doi(value)
    if len(normalized) > 512 or not DOI_PATTERN.fullmatch(normalized):
        raise web.HTTPError(400, reason="A valid DOI is required")
    return normalized


def paper_cache_root() -> Path:
    """Share ASTRA's paper cache, with an optional server-side override."""
    configured = os.environ.get("LIGHTCONE_PAPER_CACHE_DIR") or os.environ.get(
        "ASTRA_PAPER_CACHE_DIR"
    )
    return (
        Path(configured).expanduser()
        if configured
        else Path.home() / ".cache" / "astra" / "papers"
    )


def cached_paper_index(cache_root: Path) -> dict[str, CachedPaper]:
    """Index valid metadata and PDFs without following paths outside the cache.

    Cache directory names are an SDK detail: metadata supplies each DOI. When
    multiple versions exist, prefer the unversioned paper used by ASTRA evidence.
    """
    root = cache_root.expanduser().resolve()
    try:
        metadata_files = sorted(root.glob("*/meta.json"))
    except OSError:
        return {}

    papers: dict[str, CachedPaper] = {}
    for metadata_path in metadata_files:
        try:
            resolved_metadata = metadata_path.resolve()
            resolved_metadata.relative_to(root)
            pdf_path = metadata_path.with_name("paper.pdf").resolve()
            pdf_path.relative_to(root)
            metadata = json.loads(resolved_metadata.read_text(encoding="utf-8"))
            if not isinstance(metadata, dict) or not pdf_path.is_file():
                continue
            raw_doi = metadata.get("doi")
            if not isinstance(raw_doi, str):
                continue
            doi = validate_doi(raw_doi)
        except (OSError, UnicodeError, ValueError, RuntimeError, web.HTTPError):
            # A corrupt, incomplete, or externally linked cache entry must not
            # prevent access to the remaining papers.
            continue
        current = papers.get(doi)
        if current is None or (
            current[1].get("version") is not None and metadata.get("version") is None
        ):
            papers[doi] = (pdf_path, metadata)
    return papers


def find_cached_paper(doi: str, cache_root: Path) -> CachedPaper | None:
    """Find a cached paper by normalized DOI."""
    return cached_paper_index(cache_root).get(normalize_doi(doi))


def paper_payload(doi: str, metadata: dict[str, object]) -> dict[str, str]:
    """Expose display metadata without server paths or download-provider details."""
    payload = {"doi": normalize_doi(doi)}
    title = metadata.get("title")
    authors = metadata.get("authors")
    if isinstance(title, str) and title:
        payload["title"] = title
    if isinstance(authors, list):
        names = [name for name in authors if isinstance(name, str) and name]
        if names:
            payload["authors"] = ", ".join(names)
    elif isinstance(authors, str) and authors:
        payload["authors"] = authors
    return payload


def fetch_cached_paper(doi: str, cache_root: Path) -> CachedPaper:
    """Fetch one missing paper through astra-tools, reusing its cache format."""
    existing = find_cached_paper(doi, cache_root)
    if existing:
        return existing

    from astra.papers.download import download_paper_to_cache

    # astra-tools recognizes the canonical arXiv DOI spelling.
    arxiv_prefix = "10.48550/arxiv."
    download_doi = (
        f"10.48550/arXiv.{doi[len(arxiv_prefix):]}"
        if doi.startswith(arxiv_prefix)
        else doi
    )
    _, result = download_paper_to_cache(download_doi, cache_dir=cache_root)
    if not result.success:
        raise RuntimeError(result.error or "astra-tools could not fetch this paper")
    cached = find_cached_paper(doi, cache_root)
    if cached is None:
        raise RuntimeError("astra-tools did not create a readable cached PDF")
    return cached


class PaperRouteHandler(APIHandler):
    """Share cache configuration and Jupyter's contents authorization resource."""

    auth_resource = "contents"

    def initialize(self, cache_root: Path, fetch_lock: asyncio.Lock) -> None:
        """Receive state scoped to this server, rather than process globals."""
        self.cache_root = cache_root
        self.fetch_lock = fetch_lock


class PapersRouteHandler(PaperRouteHandler):
    """Return cached metadata for a bounded collection of cited DOIs."""

    @web.authenticated
    @authorized
    async def get(self) -> None:
        """Look up repeated ``doi`` query parameters in a single cache scan."""
        raw_dois = self.get_arguments("doi")
        if len(raw_dois) > MAX_LOOKUP_DOIS:
            raise web.HTTPError(400, reason=f"Request at most {MAX_LOOKUP_DOIS} DOIs")
        dois = {validate_doi(raw_doi) for raw_doi in raw_dois}
        cached = await asyncio.to_thread(cached_paper_index, self.cache_root) if dois else {}
        papers = {
            doi: paper_payload(doi, cached[doi][1]) for doi in dois if doi in cached
        }
        self.set_header("Cache-Control", "private, no-store")
        self.finish({"papers": papers})


class PaperPdfRouteHandler(PaperRouteHandler):
    """Stream a cached PDF from the authenticated Jupyter origin."""

    @web.authenticated
    @authorized
    async def get(self) -> None:
        """Read the PDF in chunks without blocking the server's event loop."""
        doi = validate_doi(self.get_query_argument("doi", default=""))
        cached = await asyncio.to_thread(find_cached_paper, doi, self.cache_root)
        if cached is None:
            raise web.HTTPError(404, reason="Paper is not cached")
        try:
            stream = await asyncio.to_thread(cached[0].open, "rb")
        except OSError as error:
            raise web.HTTPError(404, reason="Cached PDF is unavailable") from error
        with stream:
            chunk = await asyncio.to_thread(stream.read, PDF_CHUNK_SIZE)
            if not chunk.startswith(b"%PDF-"):
                raise web.HTTPError(422, reason="Cached file is not a PDF")
            self.set_header("Content-Type", "application/pdf")
            self.set_header("Content-Disposition", 'inline; filename="paper.pdf"')
            self.set_header("Content-Length", str(os.fstat(stream.fileno()).st_size))
            self.set_header("Cache-Control", "private, no-store")
            self.set_header("X-Content-Type-Options", "nosniff")
            try:
                while chunk:
                    self.write(chunk)
                    await self.flush()
                    chunk = await asyncio.to_thread(stream.read, PDF_CHUNK_SIZE)
            except StreamClosedError:
                return
        self.finish()


class PaperFetchRouteHandler(PaperRouteHandler):
    """Fetch a missing paper into the server user's ASTRA cache."""

    @web.authenticated
    @authorized
    async def post(self) -> None:
        """Download on a worker, serializing requests to avoid cache-write races."""
        body = self.get_json_body()
        raw_doi = body.get("doi") if isinstance(body, dict) else None
        if not isinstance(raw_doi, str):
            raise web.HTTPError(400, reason="A valid DOI is required")
        doi = validate_doi(raw_doi)
        try:
            async with self.fetch_lock:
                _, metadata = await asyncio.to_thread(
                    fetch_cached_paper, doi, self.cache_root
                )
        except ImportError as error:
            raise web.HTTPError(
                503, reason="astra-tools is unavailable in the Jupyter server environment"
            ) from error
        except Exception as error:
            self.log.warning("Could not fetch paper %s", doi, exc_info=True)
            raise web.HTTPError(
                502, reason="Could not fetch this paper. Check the server log for details."
            ) from error
        self.set_header("Cache-Control", "private, no-store")
        self.finish({"paper": paper_payload(doi, metadata)})


def setup_route_handlers(web_app: web.Application) -> None:
    """Register routes under the active local or JupyterHub base URL."""
    prefix = url_path_join(
        web_app.settings.get("base_url", "/"), "jupyterlab_lightcone", "api", "papers"
    )
    options = {"cache_root": paper_cache_root(), "fetch_lock": asyncio.Lock()}
    web_app.add_handlers(
        ".*$",
        [
            (prefix, PapersRouteHandler, options),
            (url_path_join(prefix, "pdf"), PaperPdfRouteHandler, options),
            (url_path_join(prefix, "fetch"), PaperFetchRouteHandler, options),
        ],
    )
