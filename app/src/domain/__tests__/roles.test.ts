/**
 * Roles and per-account overrides — ADR-0032, `domain/roles.ts`.
 *
 * Pure, no database. Two things are protected:
 *
 *   * **the base sets** — `operator`, `viewer` and `member` hold none of the account-management
 *     permissions, and `owner`/`admin` hold all of them; the Activities defaults (ADR-0038 §3). A widening here is an access
 *     decision, not a refactor.
 *   * **deny wins** — an `allow` cannot buy back a permission a `deny` took away, and a
 *     `deny` on a permission the role never had is simply a no-op.
 */

import { describe, expect, it } from 'vitest';

import {
  PERMISSIONS,
  ROLES,
  can,
  isActivitiesPermission,
  isAdministrative,
  isPermission,
  resolvePermissions,
  type Permission,
  type Role,
} from '../roles.js';

describe('the permission enumeration', () => {
  it('has no duplicates', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('recognises exactly its own members', () => {
    for (const p of PERMISSIONS) expect(isPermission(p)).toBe(true);
    for (const junk of ['accounts', 'accounts.*', 'roster.read', 'nonsense', '']) {
      expect(isPermission(junk)).toBe(false);
    }
  });
});

describe('base role sets', () => {
  it('gives owner and admin every permission', () => {
    for (const role of ['owner', 'admin'] as const) {
      const set = resolvePermissions(role, []);
      for (const p of PERMISSIONS) expect(set.has(p)).toBe(true);
    }
  });

  it('gives operator, viewer and member none of the account-management permissions', () => {
    for (const role of ['operator', 'viewer', 'member'] as const) {
      const accounts = [...resolvePermissions(role, [])].filter((p) => !isActivitiesPermission(p));
      expect(accounts, role).toEqual([]);
    }
  });

  /**
   * ADR-0038 §3 as amended by ADR-0041 §7, row for row. A change here is an access decision for
   * the DC, not a refactor.
   */
  it('sets the Activities defaults the ADR states', () => {
    const activities = (role: Role): string[] =>
      [...resolvePermissions(role, [])].filter(isActivitiesPermission).sort();
    const everything = PERMISSIONS.filter(isActivitiesPermission).sort();

    expect(activities('owner')).toEqual(everything);
    expect(activities('admin')).toEqual(everything);
    // Every account sees every post and manages its own (ADR-0041 §7).
    for (const role of ['operator', 'viewer', 'member'] as const) {
      expect(activities(role), role).toEqual([
        'activities.delete_own',
        'activities.read_all',
        'activities.upload',
      ]);
    }
  });

  it('lets the DC widen or narrow one account', () => {
    // Narrow: the DC takes "see everyone's posts" away from one account.
    expect(can('member', [], 'activities.read_all')).toBe(true);
    expect(
      can('member', [{ permission: 'activities.read_all', effect: 'deny' }], 'activities.read_all'),
    ).toBe(false);
    // Widen: one member may clear the Pending list.
    expect(can('member', [], 'activities.pending')).toBe(false);
    expect(
      can('member', [{ permission: 'activities.pending', effect: 'allow' }], 'activities.pending'),
    ).toBe(true);
    expect(
      can('operator', [{ permission: 'activities.upload', effect: 'deny' }], 'activities.upload'),
    ).toBe(false);
  });

  it('isAdministrative is true only for owner and admin', () => {
    const expected: Record<Role, boolean> = {
      owner: true,
      admin: true,
      operator: false,
      viewer: false,
      member: false,
    };
    for (const role of ROLES) expect(isAdministrative(role)).toBe(expected[role]);
  });
});

describe('overrides — deny wins', () => {
  it('an allow adds a permission the role did not have', () => {
    expect(can('operator', [], 'accounts.reset_password')).toBe(false);
    expect(
      can(
        'operator',
        [{ permission: 'accounts.reset_password', effect: 'allow' }],
        'accounts.reset_password',
      ),
    ).toBe(true);
  });

  it('a deny removes a permission the role did have', () => {
    expect(can('admin', [], 'access_log.read')).toBe(true);
    expect(
      can('admin', [{ permission: 'access_log.read', effect: 'deny' }], 'access_log.read'),
    ).toBe(false);
  });

  it('deny wins when both are present for one permission', () => {
    const overrides = [
      { permission: 'capabilities.write' as const, effect: 'allow' as const },
      { permission: 'capabilities.write' as const, effect: 'deny' as const },
    ];
    expect(can('operator', overrides, 'capabilities.write')).toBe(false);
    expect(can('admin', overrides, 'capabilities.write')).toBe(false);
  });

  it('ignores an override naming an unknown permission', () => {
    const before = resolvePermissions('admin', []);
    const after = resolvePermissions('admin', [
      { permission: 'roster.read', effect: 'deny' },
      { permission: 'made.up', effect: 'allow' },
    ]);
    expect(after).toEqual(before);
  });

  it('a deny on a permission the role never had is a no-op, not an error', () => {
    expect(
      resolvePermissions('viewer', [{ permission: 'accounts.remove', effect: 'deny' }]),
    ).toEqual(resolvePermissions('viewer', []));
  });

  it('resolvePermissions returns only real permissions', () => {
    const set = resolvePermissions('operator', [
      { permission: 'accounts.read', effect: 'allow' },
      { permission: 'garbage', effect: 'allow' },
    ]);
    for (const p of set) expect((PERMISSIONS as readonly Permission[]).includes(p)).toBe(true);
    expect(set.has('accounts.read')).toBe(true);
  });
});
