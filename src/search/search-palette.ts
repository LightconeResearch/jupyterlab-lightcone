import {
  nullTranslator,
  type TranslationBundle
} from '@jupyterlab/translation';
import { CommandRegistry } from '@lumino/commands';
import type { IDisposable } from '@lumino/disposable';
import { Signal, type ISignal } from '@lumino/signaling';
import { h, type VirtualElement } from '@lumino/virtualdom';
import { CommandPalette } from '@lumino/widgets';
import { kindMarkRenderer } from '../astra-kind';
import {
  isSurfaceKind,
  SEARCH_SECTION_ORDER,
  type ISearchCandidate
} from './search-candidates';

/** The candidate groups, each replaced as a whole when its source answers. */
export type SearchGroup =
  'sessions' | 'messages' | 'records' | 'files' | 'commands';

/** Root class of the palette; the modal wrapper adds `-Modal`. */
export const SEARCH_CLASS = 'jp-jupyterlab-lightcone-Search';

/** U+2460 CIRCLED DIGIT ONE; section `n` is marked with the n-th circled digit. */
const CIRCLED_ONE = 0x2460;

/** A section marker and its separating space at the start of a category. */
const SECTION_MARKER = /^[\u2460-\u2473] /;

/**
 * The category a candidate's palette item is filed under. Lumino sorts the
 * empty-query overview, and equally good matches, by comparing category text
 * before rank, which would list Commands first and Sessions last. A leading
 * circled digit collates as its digit, so sections follow
 * `SEARCH_SECTION_ORDER`; it is never typed, so it matches no query, and the
 * renderer drops it from headers.
 */
function sectionCategory(candidate: ISearchCandidate): string {
  const marker = String.fromCodePoint(
    CIRCLED_ONE + SEARCH_SECTION_ORDER[candidate.kind] - 1
  );
  return `${marker} ${candidate.category}`;
}

/**
 * Lumino's renderer with the caption inline after the label (JupyterLab hides
 * the stock caption) and, for records and papers, the kind mark the inventory
 * draws, in the Lightcone ASTRA theme's colours.
 */
export class SearchRenderer extends CommandPalette.Renderer {
  constructor(private readonly trans: TranslationBundle) {
    super();
  }

  renderItemIcon(data: CommandPalette.IItemRenderData): VirtualElement {
    const kind = data.item.dataset.kind;
    if (isSurfaceKind(kind)) {
      return h.div(
        {
          className: `lm-CommandPalette-itemIcon ${SEARCH_CLASS}-kind`,
          dataset: { kind }
        },
        kindMarkRenderer(kind)
      );
    }
    return super.renderItemIcon(data);
  }

  renderItemContent(data: CommandPalette.IItemRenderData): VirtualElement {
    const caption = data.item.caption;
    return h.div(
      { className: 'lm-CommandPalette-itemContent' },
      this.renderItemLabel(data),
      caption
        ? h.span(
            { className: `${SEARCH_CLASS}-caption`, title: caption },
            caption
          )
        : null
    );
  }

  /** The section name without the ordering marker `sectionCategory` adds. */
  formatHeader(data: CommandPalette.IHeaderRenderData): h.Child {
    const offset = SECTION_MARKER.exec(data.category)?.[0].length ?? 0;
    return super.formatHeader({
      category: data.category.slice(offset),
      indices:
        data.indices
          ?.map(index => index - offset)
          .filter(index => index >= 0) ?? null
    });
  }

  formatEmptyMessage(data: CommandPalette.IEmptyMessageRenderData): h.Child {
    return this.trans.__("Nothing matches '%1'", data.query);
  }
}

interface IGroupRegistration {
  registrations: IDisposable[];
  items: CommandPalette.IItem[];
}

/**
 * A command palette over a private registry, populated with bounded candidate
 * groups. Lumino filters them by category and label as the user types; files
 * only appear once there is a query, so an empty palette reads as an overview,
 * and a disabled command stays out of the results altogether.
 */
export class SearchPalette extends CommandPalette {
  constructor(options: SearchPalette.IOptions = {}) {
    const trans = options.trans ?? nullTranslator.load('jupyterlab_lightcone');
    super({
      commands: options.commands ?? new CommandRegistry(),
      renderer: new SearchRenderer(trans)
    });
    this.id = 'jupyterlab-lightcone-search';
    this.addClass(SEARCH_CLASS);
    this.inputNode.placeholder = options.placeholder ?? trans.__('Search');
  }

  /** Emitted with the candidate the user chose. */
  get selected(): ISignal<this, ISearchCandidate> {
    return this._selected;
  }

  /** The trimmed text in the search box. */
  get query(): string {
    return this.inputNode.value.trim();
  }

  set placeholder(value: string) {
    this.inputNode.placeholder = value;
  }

  /** Replace a group's candidates; identical IDs within the group collapse. */
  setCandidates(
    group: SearchGroup,
    candidates: readonly ISearchCandidate[]
  ): void {
    this._clearGroup(group);
    const registrations: IDisposable[] = [];
    const options: CommandPalette.IItemOptions[] = [];
    for (const candidate of candidates) {
      const command = `${group}:${candidate.id}`;
      if (this.commands.hasCommand(command)) {
        continue;
      }
      registrations.push(
        this.commands.addCommand(command, {
          label: candidate.label,
          caption: candidate.caption,
          icon: candidate.icon,
          dataset: { kind: candidate.kind },
          describedBy: { args: { type: 'object', properties: {} } },
          isEnabled: () => candidate.isEnabled?.() ?? true,
          // Hidden rather than greyed: a disabled row would still count as a
          // hit, so a query matching only it would show neither rows nor the
          // empty message (JupyterLab's modal hides disabled rows).
          isVisible: () =>
            (candidate.kind !== 'file' || this.query.length > 0) &&
            (candidate.isEnabled?.() ?? true),
          execute: () => {
            this._selected.emit(candidate);
          }
        })
      );
      options.push({
        command,
        category: sectionCategory(candidate),
        rank: candidate.rank
      });
    }
    const items = this.addItems(options);
    this._groups.set(group, { registrations, items });
  }

  /** Drop every candidate, for a change of project. */
  clear(): void {
    for (const group of [...this._groups.keys()]) {
      this._clearGroup(group);
    }
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.clear();
    Signal.clearData(this);
    super.dispose();
  }

  private _clearGroup(group: SearchGroup): void {
    const registered = this._groups.get(group);
    if (!registered) {
      return;
    }
    for (const item of registered.items) {
      this.removeItem(item);
    }
    for (const registration of registered.registrations) {
      registration.dispose();
    }
    this._groups.delete(group);
  }

  private readonly _selected = new Signal<this, ISearchCandidate>(this);
  private readonly _groups = new Map<SearchGroup, IGroupRegistration>();
}

export namespace SearchPalette {
  export interface IOptions {
    /** A private registry; one is created when omitted. */
    commands?: CommandRegistry;
    /** The palette's text, in the page's language; English when omitted. */
    trans?: TranslationBundle;
    /** The search box's hint; "Search" when omitted. */
    placeholder?: string;
  }
}
