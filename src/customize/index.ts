import {
  ILayoutRestorer,
  type JupyterFrontEnd,
  type JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  ICommandPalette,
  IThemeManager,
  MainAreaWidget,
  WidgetTracker
} from '@jupyterlab/apputils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { settingsIcon } from '@jupyterlab/ui-components';
import { ICurrentProject } from '../current-project';
import { CustomizeWidget } from './customize-widget';

export namespace CustomizeCommandIDs {
  /** Open, or reveal, the single Lightcone settings tab. */
  export const openCustomize = 'jupyterlab_lightcone:open-customize';
}

const CATEGORY = 'Lightcone Lab';
const WIDGET_ID = 'lightcone-customize';

/**
 * The Lightcone settings page: one main-area tab of real state, following
 * the current project, restored across reloads.
 */
export const customizePlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:customize',
  description:
    'The Lightcone settings page: agents, skills, project instructions, environment, execution boundary, storage and appearance.',
  autoStart: true,
  requires: [ICurrentProject, IThemeManager],
  optional: [ICommandPalette, ILayoutRestorer, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    current: ICurrentProject,
    themes: IThemeManager,
    palette: ICommandPalette | null,
    restorer: ILayoutRestorer | null,
    translator: ITranslator | null
  ) => {
    const trans = (translator ?? nullTranslator).load('jupyterlab_lightcone');
    const tracker = new WidgetTracker<MainAreaWidget<CustomizeWidget>>({
      namespace: WIDGET_ID
    });
    app.commands.addCommand(CustomizeCommandIDs.openCustomize, {
      label: trans.__('Lightcone Settings'),
      caption: trans.__(
        'Agents, skills, project instructions, environment, execution boundary, storage and appearance'
      ),
      icon: settingsIcon,
      describedBy: { args: { type: 'object', properties: {} } },
      execute: async () => {
        let widget = tracker.find(candidate => !candidate.isDisposed);
        if (!widget) {
          const content = new CustomizeWidget({
            settings: app.serviceManager.serverSettings,
            current,
            themes,
            commands: app.commands,
            translator: translator ?? undefined
          });
          widget = new MainAreaWidget({ content });
          widget.id = WIDGET_ID;
          await tracker.add(widget);
          app.shell.add(widget, 'main');
        }
        app.shell.activateById(widget.id);
        return widget;
      }
    });
    palette?.addItem({
      command: CustomizeCommandIDs.openCustomize,
      category: CATEGORY
    });
    if (restorer) {
      void restorer.restore(tracker, {
        command: CustomizeCommandIDs.openCustomize,
        name: () => WIDGET_ID
      });
    }
  }
};

export { CustomizeWidget, CHANGE_THEME_COMMAND } from './customize-widget';
export {
  attentionCount,
  attentionSummary,
  customizeSections,
  themeChoices,
  type CustomizeRowState,
  type CustomizeSectionId,
  type ICustomizeAction,
  type ICustomizeRow,
  type ICustomizeSection,
  type IThemeChoice,
  type IThemeChoices
} from './customize-model';
export {
  fetchSetup,
  isSetupReport,
  type IAgentSetup,
  type ISetupReport,
  type ISkillSetup,
  type ITool
} from './setup-api';
