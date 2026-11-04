/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, expect, it } from 'vitest';

import {
  decideRequest,
  isAllowedHealCommand,
} from '../../../src/infrastructure/local-viewer-adapter/request-guard';

const HOST = 'localhost:4321';
const SELF = `http://${HOST}`;

const request = (over: Partial<Parameters<typeof decideRequest>[0]> = {}) => ({
  method: 'GET',
  pathname: '/api/executions',
  host: HOST,
  origin: undefined,
  secFetchSite: undefined,
  ...over,
});

describe('decideRequest', () => {
  it('lets the viewer page load whatever the caller', () => {
    expect(decideRequest(request({ pathname: '/', secFetchSite: 'cross-site' }))).toMatchObject({
      allowed: true,
      corsOrigin: null,
    });
  });

  it('answers the API to its own page, a typed URL and a tool that is not a browser', () => {
    for (const secFetchSite of ['same-origin', 'none', undefined]) {
      expect(decideRequest(request({ secFetchSite })).allowed).toBe(true);
    }
    expect(decideRequest(request({ origin: SELF }))).toEqual({
      allowed: true,
      corsOrigin: SELF,
      privateNetwork: false,
    });
  });

  it('refuses the API to another site, with or without an Origin', () => {
    expect(decideRequest(request({ origin: 'https://evil.example' })).allowed).toBe(false);
    expect(decideRequest(request({ secFetchSite: 'cross-site' })).allowed).toBe(false);
    expect(decideRequest(request({ secFetchSite: 'same-site' })).allowed).toBe(false);
    expect(
      decideRequest(request({ origin: 'http://localhost:9999', secFetchSite: 'same-site' }))
        .allowed,
    ).toBe(false);
  });

  it('answers the origins the developer named', () => {
    expect(
      decideRequest(request({ origin: 'http://localhost:5173' }), {
        allowedOrigins: ['http://localhost:5173'],
      }),
    ).toMatchObject({ allowed: true, corsOrigin: 'http://localhost:5173' });
  });

  it("lets Playwright's trace viewer read trace files only", () => {
    const playwright = { origin: 'https://trace.playwright.dev', secFetchSite: 'cross-site' };
    const asset = '/api/executions/e1/asset/t1/0/trace.zip';

    expect(decideRequest(request({ ...playwright, pathname: asset }))).toEqual({
      allowed: true,
      corsOrigin: 'https://trace.playwright.dev',
      privateNetwork: true,
    });
    expect(
      decideRequest(request({ ...playwright, method: 'POST', pathname: '/api/exec' })).allowed,
    ).toBe(false);
    expect(decideRequest(request({ ...playwright, pathname: '/api/exec/abc' })).allowed).toBe(
      false,
    );
    expect(
      decideRequest(request({ ...playwright, pathname: '/api/executions/e1/tests/t1/0/analyze' }))
        .allowed,
    ).toBe(false);
  });

  it('refuses a Host that is not this viewer, even for the page', () => {
    expect(decideRequest(request({ host: 'evil.example:4321', pathname: '/' })).allowed).toBe(
      false,
    );
    expect(decideRequest(request({ host: undefined })).allowed).toBe(false);
    for (const host of ['127.0.0.1:4321', '[::1]:4321', 'LOCALHOST:4321']) {
      expect(decideRequest(request({ host })).allowed).toBe(true);
    }
    expect(
      decideRequest(request({ host: 'box.local:4321' }), { hostname: 'box.local' }).allowed,
    ).toBe(true);
  });
});

describe('isAllowedHealCommand', () => {
  it('runs the commands of the viewer page', () => {
    expect(isAllowedHealCommand(['whoami', '--json'], SELF)).toBe(true);
    expect(isAllowedHealCommand(['quota', '--json'], SELF)).toBe(true);
    expect(isAllowedHealCommand(['login', '--json', '--return-to', `${SELF}/?e=1`], SELF)).toBe(
      true,
    );
  });

  it('runs nothing else', () => {
    expect(isAllowedHealCommand(['logout'], SELF)).toBe(false);
    expect(isAllowedHealCommand(['analyze', '--json'], SELF)).toBe(false);
    expect(isAllowedHealCommand(['whoami'], SELF)).toBe(false);
    expect(
      isAllowedHealCommand(['login', '--json', '--return-to', 'https://evil.example/'], SELF),
    ).toBe(false);
    expect(
      isAllowedHealCommand(['login', '--json', '--return-to', `${SELF}.evil.example/`], SELF),
    ).toBe(false);
  });
});
