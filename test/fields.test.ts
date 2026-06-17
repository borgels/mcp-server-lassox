import { describe, expect, it } from 'vitest';
import { selectFields } from '../src/lasso/fields.js';

const entity = {
  lassoId: 'CVR-1-34580820',
  cvr: 34580820,
  name: 'LASSO X A/S',
  status: 'NORMAL',
  address: { streetName: 'Vesterbrogade', zipCode: '1620', city: 'København V' },
  industry: { text: 'Computerprogrammering', code: '620100' },
  management: { members: [{ name: 'Alice', role: 'CEO' }, { name: 'Bob', role: 'CFO' }] },
};

describe('selectFields', () => {
  it('returns the value unchanged when no fields are given', () => {
    expect(selectFields(entity, [])).toBe(entity);
    expect(selectFields(entity, ['  ', ''])).toBe(entity);
  });

  it('keeps only the requested top-level fields', () => {
    expect(selectFields(entity, ['name', 'cvr'])).toEqual({ name: 'LASSO X A/S', cvr: 34580820 });
  });

  it('descends into nested objects via dot paths', () => {
    expect(selectFields(entity, ['name', 'address.zipCode', 'industry.text'])).toEqual({
      name: 'LASSO X A/S',
      address: { zipCode: '1620' },
      industry: { text: 'Computerprogrammering' },
    });
  });

  it('keeps a whole subtree when the path names the object itself', () => {
    expect(selectFields(entity, ['address'])).toEqual({
      address: { streetName: 'Vesterbrogade', zipCode: '1620', city: 'København V' },
    });
  });

  it('maps array elements through the remaining path', () => {
    expect(selectFields(entity, ['management.members.name'])).toEqual({
      management: { members: [{ name: 'Alice' }, { name: 'Bob' }] },
    });
  });

  it('silently skips unknown fields', () => {
    expect(selectFields(entity, ['name', 'doesNotExist', 'address.missing'])).toEqual({
      name: 'LASSO X A/S',
      address: {},
    });
  });

  it('projects every element of a top-level array', () => {
    const list = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
    expect(selectFields(list, ['a'])).toEqual([{ a: 1 }, { a: 3 }]);
  });
});
