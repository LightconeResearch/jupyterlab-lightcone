import { Dialog, showDialog } from '@jupyterlab/apputils';
import type { TranslationBundle } from '@jupyterlab/translation';
import { ReactWidget } from '@jupyterlab/ui-components';
import React from 'react';
import type { ComputeBackend, IClusterPreset } from './compute-api';
import { presetCaption } from './compute-presets';

const BASE = 'jp-jupyterlab-lightcone-CustomCluster';

/** A field of the Custom… form: which preset field it sets, and how. */
interface IField {
  name: keyof IClusterPreset;
  label: string;
  type: 'number' | 'text';
  value: string;
  help?: string;
}

function fields(backend: ComputeBackend, trans: TranslationBundle): IField[] {
  switch (backend) {
    case 'slurm':
      return [
        { name: 'nodes', label: trans.__('Nodes'), type: 'number', value: '1' },
        {
          name: 'time',
          label: trans.__('Time limit'),
          type: 'text',
          value: '1:00:00',
          help: trans.__('As Slurm writes it: 30, 2:00:00 or 1-00:00:00.')
        },
        { name: 'qos', label: trans.__('QOS'), type: 'text', value: '' },
        {
          name: 'constraint',
          label: trans.__('Constraint'),
          type: 'text',
          value: '',
          help: trans.__('Such as cpu or gpu.')
        },
        {
          name: 'account',
          label: trans.__('Account'),
          type: 'text',
          value: '',
          help: trans.__('Empty: your default account.')
        }
      ];
    case 'gateway':
      return [
        {
          name: 'workers',
          label: trans.__('Up to workers'),
          type: 'number',
          value: '2'
        },
        {
          name: 'cores',
          label: trans.__('Cores each'),
          type: 'number',
          value: ''
        },
        {
          name: 'memory',
          label: trans.__('Memory each (GB)'),
          type: 'number',
          value: ''
        }
      ];
    default:
      return [
        {
          name: 'threads',
          label: trans.__('Threads'),
          type: 'number',
          value: '',
          help: trans.__('Empty: every core.')
        }
      ];
  }
}

/** What the Custom… dialog returns. */
export interface ICustomCluster {
  preset: IClusterPreset;
  /** Whether to add the preset to the Compute settings. */
  save: boolean;
}

/** The Custom… form; its values are read back from the DOM on accept. */
class CustomClusterBody
  extends ReactWidget
  implements Dialog.IBodyWidget<ICustomCluster>
{
  constructor(
    private readonly _backend: ComputeBackend,
    private readonly _trans: TranslationBundle
  ) {
    super();
    this.addClass(BASE);
  }

  getValue(): ICustomCluster {
    const preset: IClusterPreset = { label: '', backend: this._backend };
    for (const field of fields(this._backend, this._trans)) {
      const input = this.node.querySelector<HTMLInputElement>(
        `input[name="${field.name}"]`
      );
      const raw = input?.value.trim() ?? '';
      if (!raw) {
        continue;
      }
      if (field.type === 'number') {
        const number = Number(raw);
        if (Number.isFinite(number)) {
          Object.assign(preset, { [field.name]: number });
        }
      } else {
        Object.assign(preset, { [field.name]: raw });
      }
    }
    const label = this.node.querySelector<HTMLInputElement>(
      'input[name="label"]'
    );
    preset.label = label?.value.trim() || presetCaption(preset, this._trans);
    const save =
      this.node.querySelector<HTMLInputElement>('input[name="save"]');
    return { preset, save: !!save?.checked };
  }

  protected render(): React.ReactElement {
    const trans = this._trans;
    const id = (name: string) => `${this.id}-${name}`;
    return (
      <div className={`${BASE}-form`}>
        {fields(this._backend, trans).map(field => (
          <div className={`${BASE}-field`} key={field.name}>
            <label htmlFor={id(field.name)}>{field.label}</label>
            <input
              id={id(field.name)}
              name={field.name}
              className="jp-mod-styled"
              type={field.type}
              min={field.type === 'number' ? 0 : undefined}
              defaultValue={field.value}
            />
            {field.help ? (
              <span className={`${BASE}-help`}>{field.help}</span>
            ) : null}
          </div>
        ))}
        <div className={`${BASE}-field`}>
          <label htmlFor={id('label')}>{trans.__('Name')}</label>
          <input
            id={id('label')}
            name="label"
            className="jp-mod-styled"
            type="text"
            maxLength={80}
            placeholder={trans.__('Named from its size')}
          />
        </div>
        <label className={`${BASE}-save`}>
          <input name="save" type="checkbox" />
          {trans.__('Save as a preset')}
        </label>
      </div>
    );
  }
}

/** Ask for a one-off cluster size; null when the user cancels. */
export async function askCustomCluster(
  backend: ComputeBackend,
  trans: TranslationBundle
): Promise<ICustomCluster | null> {
  const result = await showDialog({
    title: trans.__('Custom cluster'),
    body: new CustomClusterBody(backend, trans),
    buttons: [
      Dialog.cancelButton(),
      Dialog.okButton({
        label:
          backend === 'slurm'
            ? trans.__('Submit job')
            : trans.__('Start cluster')
      })
    ]
  });
  return result.button.accept && result.value ? result.value : null;
}
