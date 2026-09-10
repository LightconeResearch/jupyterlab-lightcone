import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

/** Build an extension URL under the active server, including JupyterHub prefixes. */
export function apiUrl(
  endpoint: string,
  settings: ServerConnection.ISettings
): string {
  return URLExt.join(settings.baseUrl, 'jupyterlab_lightcone', endpoint);
}

/**
 * Make an authenticated JSON request; callers validate the response contract.
 * A 204 response resolves to undefined.
 */
export async function requestAPI(
  endpoint: string,
  settings: ServerConnection.ISettings,
  init: RequestInit = {}
): Promise<unknown> {
  let response: Response;
  try {
    response = await ServerConnection.makeRequest(
      apiUrl(endpoint, settings),
      init,
      settings
    );
  } catch (error) {
    throw new ServerConnection.NetworkError(
      error instanceof Error ? error : new Error(String(error))
    );
  }
  if (!response.ok) {
    throw await ServerConnection.ResponseError.create(response);
  }
  if (response.status === 204) {
    return undefined;
  }
  return response.json();
}
