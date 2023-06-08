import { describe, expect, it } from 'vitest';

import { lineIntersects } from './math-utils.js';

describe('Line', () => {
  it('should intersect', () => {
    const rst = lineIntersects([0, 0], [1, 1], [0, 1], [1, 0]);
    expect(rst).toBeDefined();
    expect(rst).toMatchObject([0.5, 0.5]);
  });

  it('should not intersect', () => {
    const rst = lineIntersects([0, 0], [1, 0], [0, 1], [1, 1]);
    expect(rst).toBeNull();
  });

  it('should intersect when infinity', () => {
    const rst = lineIntersects([0, 0], [0, 10], [1, 1], [10, 1], true);
    expect(rst).toBeDefined();
    expect(rst).toMatchObject([0, 1]);
  });
});