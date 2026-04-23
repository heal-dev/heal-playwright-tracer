/**
 * Copyright: (c) Myia SAS 2026.
 * This file and its contents are licensed under the AGPLv3 License.
 * Please see the LICENSE file at the root of this repository
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { HealDataLayout } from '../../../src/infrastructure/heal-data-layout';

describe('HealDataLayout', () => {
  it('derives healDataDir from the test outputDir and the SUBDIR constant', () => {
    const layout = new HealDataLayout('/tmp/test-output');
    expect(layout.healDataDir).toBe(path.join('/tmp/test-output', HealDataLayout.SUBDIR));
  });

  it('derives ndjsonPath from healDataDir and the NDJSON_FILENAME constant', () => {
    const layout = new HealDataLayout('/tmp/test-output');
    expect(layout.ndjsonPath).toBe(
      path.join('/tmp/test-output', HealDataLayout.SUBDIR, HealDataLayout.NDJSON_FILENAME),
    );
  });

  it('exposes the outputDir unchanged', () => {
    const layout = new HealDataLayout('/tmp/test-output');
    expect(layout.outputDir).toBe('/tmp/test-output');
  });

  it('advertises the canonical subdir and filename as static constants', () => {
    expect(HealDataLayout.SUBDIR).toBe('heal-data');
    expect(HealDataLayout.NDJSON_FILENAME).toBe('heal-traces.ndjson');
  });
});
