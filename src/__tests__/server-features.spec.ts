import { ContentsManager, Drive } from '@jupyterlab/services';
import {
  hasChatAgents,
  hasLightconeServer,
  serverReadsProject
} from '../server-features';
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

describe('hasChatAgents', () => {
  it('is false in the browser-only install', () => {
    expect(hasChatAgents('true')).toBe(false);
  });

  describe('with the engine install', () => {
    withLightconeServer({ chatAgents: false });

    it('leaves the agents to a terminal', () => {
      expect(hasLightconeServer()).toBe(true);
      expect(hasChatAgents()).toBe(false);
    });
  });

  describe('with the ai install', () => {
    withLightconeServer();

    it('runs the agents in Jupyter AI chats', () => {
      expect(hasChatAgents()).toBe(true);
    });
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
