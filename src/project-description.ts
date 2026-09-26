import { Dialog } from '@jupyterlab/apputils';
import type { TranslationBundle } from '@jupyterlab/translation';
import { Widget } from '@lumino/widgets';

/** A multiline description field inside JupyterLab's standard dialog. */
class DescriptionInput extends Widget {
  constructor(text: string, trans: TranslationBundle) {
    super();
    this.addClass('jp-jupyterlab-lightcone-DescriptionInput');
    const label = document.createElement('label');
    label.textContent = trans.__('Description');
    this._input = document.createElement('textarea');
    this._input.className = 'jp-mod-styled';
    this._input.rows = 10;
    this._input.value = text;
    this._input.placeholder = trans.__(
      'Describe the question, approach, and main findings of this analysis.'
    );
    label.appendChild(this._input);
    this.node.appendChild(label);
  }

  /** The value returned only when the dialog is accepted. */
  getValue(): string {
    return this._input.value;
  }

  private readonly _input: HTMLTextAreaElement;
}

/** Keep native paragraph entry, which the stock dialog's Enter handler cancels. */
class DescriptionDialog extends Dialog<string> {
  protected _evtKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && event.target instanceof HTMLTextAreaElement) {
      event.stopPropagation();
      return;
    }
    super._evtKeydown(event);
  }
}

/** Ask for the description; null means the user cancelled. */
export async function editDescription(
  text: string,
  trans: TranslationBundle
): Promise<string | null> {
  // eslint-disable-next-line jupyter/require-disposable-ownership -- Disposed in the finally block after launch settles.
  const dialog = new DescriptionDialog({
    title: trans.__('Edit description'),
    body: new DescriptionInput(text, trans),
    focusNodeSelector: 'textarea',
    buttons: [
      Dialog.cancelButton(),
      Dialog.okButton({ label: trans.__('Save') })
    ]
  });
  try {
    const result = await dialog.launch();
    return result.button.accept ? result.value : null;
  } finally {
    dialog.dispose();
  }
}
