import { LabIcon, addIcon, folderIcon } from '@jupyterlab/ui-components';
import astraLogoSvg from '../style/astra-logo.svg';
import lightconeLogoSvg from '../style/lightcone-logo.svg';
import mystLogoSvg from '../style/myst-logo.svg';

/** The ASTRA mark used for inventory commands and analysis documents. */
export const astraIcon = new LabIcon({
  name: 'jupyterlab-lightcone:astra',
  svgstr: astraLogoSvg
}).bindprops({ className: 'jp-jupyterlab-lightcone-InventoryIcon' });

/** The Lightcone mark used by Home, the sidebar and their tabs. */
export const lightconeIcon = new LabIcon({
  name: 'jupyterlab-lightcone:lightcone',
  svgstr: lightconeLogoSvg
});

/** The official MyST mark used for the MySTRA publication viewer. */
export const mystIcon = new LabIcon({
  name: 'jupyterlab-lightcone:myst',
  svgstr: mystLogoSvg
});

/** Project actions use the same accent as inventory and agent icons. */
export const createProjectIcon = addIcon.bindprops({
  className: 'jp-jupyterlab-lightcone-ProjectActionIcon'
});
export const openProjectIcon = folderIcon.bindprops({
  className: 'jp-jupyterlab-lightcone-ProjectActionIcon'
});
