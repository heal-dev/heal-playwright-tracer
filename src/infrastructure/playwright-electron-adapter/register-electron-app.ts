/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

// Registers an ElectronApplication with the running test: its context
// gets an id, its windows get page ids at creation plus a video watcher
// (`registerContext`, the same path a popup context takes), the capture
// sessions attach to the context, and the context is marked `electron`
// so teardown attaches the video under the name `video` and labels the
// page `window-n`.
//
// Idempotent per (registry, app): the launch hook and the public
// `registerElectronApp` may both see one app in one test. Best-effort:
// nothing here may break a launch.

import type { BrowserContext, ElectronApplication } from 'playwright';
import { registerContext, type PageRegistry } from '../playwright-page-registry-adapter';
import { getActiveElectronHook } from './active-electron-hook';
import { log } from '../../util/logger';

/** Just enough of a capture session to wire a context — structural, like `WireableSession`. */
export interface ElectronWireableSession {
  attachToContext(ctx: BrowserContext): void;
}

export interface RegisterElectronAppOptions {
  app: ElectronApplication;
  registry: PageRegistry;
  sessions: ElectronWireableSession[];
  /** False for an app the host owns: never closed by the tracer, video not attached. */
  owned: boolean;
}

// One WeakSet per registry, i.e. per test: an app kept across tests
// (`beforeAll`) and registered by hand in each one is wired once per test.
const seenByRegistry = new WeakMap<PageRegistry, WeakSet<ElectronApplication>>();

function seen(registry: PageRegistry): WeakSet<ElectronApplication> {
  let set = seenByRegistry.get(registry);
  if (!set) {
    set = new WeakSet();
    seenByRegistry.set(registry, set);
  }
  return set;
}

export function registerElectronApp(opts: RegisterElectronAppOptions): void {
  const { app, registry, sessions, owned } = opts;
  const apps = seen(registry);
  if (apps.has(app)) return;
  apps.add(app);

  let ctx: BrowserContext;
  try {
    ctx = app.context();
  } catch (err) {
    log.warn('electron app context unavailable; the app is not traced', err);
    return;
  }
  registry.markContext(ctx, owned ? { kind: 'electron' } : { kind: 'electron', owned: false });
  registerContext(registry, ctx);
  for (const session of sessions) {
    try {
      session.attachToContext(ctx);
    } catch (err) {
      log.warn('a capture session could not attach to the electron context', err);
    }
  }
}

/**
 * The by-hand entry point: hand an app the tracer did not see launch
 * (a `beforeAll` app, or one launched through a second Playwright copy)
 * to the running test. Attribution and capture only — the host keeps
 * the app, so the tracer never closes it nor attaches its video.
 * A no-op, with a warning, outside a traced test.
 */
export function registerActiveElectronApp(app: ElectronApplication): void {
  const hook = getActiveElectronHook();
  if (!hook) {
    log.warn('registerElectronApp called outside a traced test; nothing registered');
    return;
  }
  try {
    hook.onLaunched(app, { owned: false });
  } catch (err) {
    // Best-effort, like every tracing path: a host's beforeEach must
    // never fail because the app could not be traced.
    log.warn('registerElectronApp failed; the app is not traced', err);
  }
}
