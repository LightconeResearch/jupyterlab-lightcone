import type { TranslationBundle } from '@jupyterlab/translation';

/** A translated label for ASTRA output types and a readable fallback. */
export function outputKindLabel(
  type: string | undefined,
  trans: TranslationBundle
): string {
  switch (type) {
    case 'figure':
      return trans.__('Figure');
    case 'table':
      return trans.__('Table');
    case 'metric':
      return trans.__('Metric');
    case 'data':
      return trans.__('Data');
    case 'report':
      return trans.__('Report');
    default:
      return type ? type[0].toUpperCase() + type.slice(1) : trans.__('Output');
  }
}
