/**
 * Identifiers several workbench features share: palette categories, the
 * title data keys record and session tabs carry, and the ids of the Jupyter
 * Chat commands and factory the workbench drives. One definition each, so the
 * sidebar, the tab labeller, the sessions and the record tabs agree.
 */

/** The command palette and launcher category of every Lightcone command. */
export const PALETTE_CATEGORY = 'Lightcone Lab';

/** The title data key every record tab carries (see `ElementWidget`). */
export const ELEMENT_TAB_DATASET_KEY = 'lightcone-element';

/**
 * The title data key holding a session's title, which its tab shows in place
 * of the file name (see `style/sessions.css`). The label itself must stay the
 * file name: a document widget renames its file to match its label.
 */
export const SESSION_TITLE_DATASET_KEY = 'lightcone-session-title';

/** Jupyter Chat's command creating a chat document (`jupyterlab-chat` extension). */
export const CREATE_CHAT_COMMAND = 'jupyterlab-chat:create';

/** Jupyter Chat's document factory for `.chat` files. */
export const CHAT_FACTORY = 'Chat';

/** Record tab widget ids start with this, followed by a UUID. */
export const ELEMENT_TAB_ID_PREFIX = 'lightcone-element-';

/** Whether a widget id names a record tab. */
export function isElementTabId(id: string): boolean {
  return /^lightcone-element-[a-zA-Z0-9-]+$/.test(id);
}
