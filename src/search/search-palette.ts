import { surfaceGlyph } from '@astra-spec/ui/model';
import { CommandRegistry } from '@lumino/commands';
import type { IDisposable } from '@lumino/disposable';
import { Signal, type ISignal } from '@lumino/signaling';
import { h, type VirtualElement } from '@lumino/virtualdom';
import { CommandPalette } from '@lumino/widgets';
import { isSurfaceKind, type ISearchCandidate } from './search-candidates';

/** The candidate groups, each replaced as a whole when its source answers. */
export type SearchGroup = 'sessions' | 'records' | 'files' | 'commands';

/** Root class of the palette; the modal wrapper adds `-Modal`. */
export const SEARCH_CLASS = 'jp-jupyterlab-lightcone-Search';

/**
 * Lumino's renderer with the caption inline after the label (JupyterLab hides
 * the stock caption) and ASTRA kind glyphs for records and papers.
 */
export class SearchRenderer extends CommandPalette.Renderer {
  renderItemIcon(data: CommandPalette.IItemRenderData): VirtualElement {
    const kind = data.item.dataset.kind;
    if (isSurfaceKind(kind)) {
      return h.div(
        {
          className: `lm-CommandPalette-itemIcon ${SEARCH_CLASS}-glyph`,
          dataset: { kind }
        },
        surfaceGlyph(kind)
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

  formatEmptyMessage(data: CommandPalette.IEmptyMessageRenderData): h.Child {
    return `Nothing matches '${data.query}'`;
  }
}

interface IGroupRegistration {
  registrations: IDisposable[];
  items: CommandPalette.IItem[];
  candidates: ISearchCandidate[];
}

/**
 * A command palette over a private registry, populated with bounded candidate
 * groups. Lumino filters them by category and label as the user types; files
 * only appear once there is a query, so an empty palette reads as an overview.
 */
export class SearchPalette extends CommandPalette {
  constructor(options: SearchPalette.IOptions = {}) {
    super({
      commands: options.commands ?? new CommandRegistry(),
      renderer: new SearchRenderer()
    });
    this.id = 'jupyterlab-lightcone-search';
    this.addClass(SEARCH_CLASS);
    this.inputNode.placeholder = options.placeholder ?? 'Search';
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

  /** The candidates currently offered for a group. */
  candidates(group: SearchGroup): readonly ISearchCandidate[] {
    return this._groups.get(group)?.candidates ?? [];
  }

  /** Replace a group's candidates; identical IDs within the group collapse. */
  setCandidates(
    group: SearchGroup,
    candidates: readonly ISearchCandidate[]
  ): void {
    this._clearGroup(group);
    const registrations: IDisposable[] = [];
    const options: CommandPalette.IItemOptions[] = [];
    const kept: ISearchCandidate[] = [];
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
          isVisible: () => candidate.kind !== 'file' || this.query.length > 0,
          execute: () => {
            this._selected.emit(candidate);
          }
        })
      );
      options.push({
        command,
        category: candidate.category,
        rank: candidate.rank
      });
      kept.push(candidate);
    }
    const items = this.addItems(options);
    this._groups.set(group, { registrations, items, candidates: kept });
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
    placeholder?: string;
  }
}
