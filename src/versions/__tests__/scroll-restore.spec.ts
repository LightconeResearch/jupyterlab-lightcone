import { restoreScrollOffset } from '../scroll-restore';

/** A ResizeObserver whose growth is reported by the test. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;

  constructor(private readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  grow(): void {
    if (!this.disconnected) {
      this.callback();
    }
  }
}

/** A scroll container that clamps its offset to `max`, as a browser does. */
function scroller(max: number): HTMLDivElement & { max: number } {
  const element = Object.assign(document.createElement('div'), { max });
  element.appendChild(document.createElement('div'));
  let top = 0;
  Object.defineProperty(element, 'scrollTop', {
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, element.max));
    }
  });
  return element;
}

beforeEach(() => {
  FakeResizeObserver.instances = [];
  Object.assign(globalThis, { ResizeObserver: FakeResizeObserver });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'ResizeObserver');
});

test('an offset within reach is applied at once', () => {
  const element = scroller(1000);
  const stop = restoreScrollOffset(element, 400);
  expect(element.scrollTop).toBe(400);
  expect(FakeResizeObserver.instances).toHaveLength(0);
  stop();
});

test('an offset beyond the body is applied again as the body grows', () => {
  const element = scroller(100);
  restoreScrollOffset(element, 400);
  expect(element.scrollTop).toBe(100);
  const [observer] = FakeResizeObserver.instances;
  expect(observer.observed).toEqual([element.firstElementChild]);
  element.max = 250;
  observer.grow();
  expect(element.scrollTop).toBe(250);
  expect(observer.disconnected).toBe(false);
  element.max = 900;
  observer.grow();
  expect(element.scrollTop).toBe(400);
  expect(observer.disconnected).toBe(true);
});

test('the reader taking over ends the wait', () => {
  const element = scroller(100);
  restoreScrollOffset(element, 400);
  const [observer] = FakeResizeObserver.instances;
  element.dispatchEvent(new Event('wheel'));
  expect(observer.disconnected).toBe(true);
  element.max = 900;
  observer.grow();
  expect(element.scrollTop).toBe(100);
});

test('a scroll made by other code is corrected by the next growth', () => {
  const element = scroller(100);
  restoreScrollOffset(element, 400);
  const [observer] = FakeResizeObserver.instances;
  element.scrollTop = 40;
  element.dispatchEvent(new Event('scroll'));
  expect(observer.disconnected).toBe(false);
  element.max = 900;
  observer.grow();
  expect(element.scrollTop).toBe(400);
});

test('stopping early leaves the body alone', () => {
  const element = scroller(100);
  const stop = restoreScrollOffset(element, 400);
  stop();
  const [observer] = FakeResizeObserver.instances;
  expect(observer.disconnected).toBe(true);
  element.max = 900;
  observer.grow();
  expect(element.scrollTop).toBe(100);
});

test('without ResizeObserver the offset is applied once', () => {
  Reflect.deleteProperty(globalThis, 'ResizeObserver');
  const element = scroller(100);
  restoreScrollOffset(element, 400);
  expect(element.scrollTop).toBe(100);
  expect(FakeResizeObserver.instances).toHaveLength(0);
});
