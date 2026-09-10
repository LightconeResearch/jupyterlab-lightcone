import { LabIcon } from '@jupyterlab/ui-components';
import astraLogoSvg from '../style/astra-logo.svg';
import mystLogoSvg from '../style/myst-logo.svg';

/** The ASTRA mark used for inventory commands and analysis documents. */
export const astraIcon = new LabIcon({
  name: 'jupyterlab-lightcone:astra',
  svgstr: astraLogoSvg
}).bindprops({ className: 'jp-jupyterlab-lightcone-InventoryIcon' });

/** The official MyST mark used for the MySTRA publication viewer. */
export const mystIcon = new LabIcon({
  name: 'jupyterlab-lightcone:myst',
  svgstr: mystLogoSvg
});
