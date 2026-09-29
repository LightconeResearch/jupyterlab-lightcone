import { ContentsManager, Drive } from '@jupyterlab/services';
import { hasLightconeServer, serverReadsProject } from '../server-features';
import { withLightconeServer } from './server-fixtures';

describe('hasLightconeServer', () => {
  it('holds only when the server extension announces its routes', () => {
    expect(hasLightconeServer('true')).toBe(true);
    for (const option of ['', 'false', 'True', '1']) {
      expect(hasLightconeServer(option)).toBe(false);
    }
  });

  it('reads the page configuration by default', () => {
    expect(hasLightconeServer()).toBe(false);
  });
});

describe('serverReadsProject', () => {
  const contents = new ContentsManager();
  contents.addDrive(new Drive({ name: 'Drive' }));
  afterAll(() => contents.dispose());

  it('is false in the browser-only install', () => {
    expect(serverReadsProject(contents, 'project/astra.yaml')).toBe(false);
  });

  describe('with Lightcone’s server', () => {
    withLightconeServer();

    it('reads projects on the local drive only', () => {
      expect(hasLightconeServer()).toBe(true);
      expect(serverReadsProject(contents, 'project/astra.yaml')).toBe(true);
      expect(serverReadsProject(contents, 'Drive:project/astra.yaml')).toBe(
        false
      );
    });
  });
});
