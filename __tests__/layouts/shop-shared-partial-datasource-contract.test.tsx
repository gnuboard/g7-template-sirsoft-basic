/**
 * @file shop-shared-partial-datasource-contract.test.tsx
 * @description 공유 partial 이 참조하는 데이터소스가 모든 포함 레이아웃에 존재하는지 전수 검사 (#519 회귀)
 *
 * 배경:
 *   shop/index 를 단일 storefront 데이터소스로 통합하면서, 여러 레이아웃이 함께 쓰는
 *   partial 을 index 전용 데이터소스 이름에 결합시켰다. 그 결과 shop/category 의 상품
 *   그리드와 shop/show 의 인기 상품 섹션이 예외도 404 도 없이 화면에서만 사라졌다.
 *   `?? []` 폴백 때문에 런타임 오류가 나지 않아 어떤 정적 검사에도 걸리지 않는 유형이다.
 *
 * 검사 방식:
 *   특정 파일을 열거하지 않는다. layouts/**\/*.json 전수를 읽어
 *     ① 템플릿 전체의 데이터소스 ID 집합을 만들고
 *     ② partial 이 표현식에서 참조하는 루트 식별자 중 ①에 속한 것만 추려
 *     ③ 그 partial 을 포함하는 모든 레이아웃이 해당 ID 를 실제로 정의하는지 확인한다.
 *   새 partial/레이아웃이 추가돼도 목록 갱신 없이 자동으로 검사 대상이 된다.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const layoutsRoot = path.resolve(__dirname, '../../layouts');

/** layouts 하위 모든 JSON 을 재귀 수집한다 */
function collectLayoutFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectLayoutFiles(full, acc);
    else if (entry.name.endsWith('.json')) acc.push(full);
  }
  return acc;
}

/** layouts 루트 기준 상대 경로 (partial 참조 문자열과 같은 형태) */
function toRelative(file: string): string {
  return path.relative(layoutsRoot, file).split(path.sep).join('/');
}

const layoutFiles = collectLayoutFiles(layoutsRoot);
const parsed = new Map<string, any>();
for (const file of layoutFiles) {
  parsed.set(toRelative(file), JSON.parse(fs.readFileSync(file, 'utf-8')));
}

/** 노드 트리 전체를 순회하며 문자열 값을 모은다 */
function collectStrings(node: any, acc: string[] = []): string[] {
  if (typeof node === 'string') {
    acc.push(node);
    return acc;
  }
  if (!node || typeof node !== 'object') return acc;
  for (const value of Object.values(node)) collectStrings(value, acc);
  return acc;
}

/** 이 레이아웃이 정의한 데이터소스 ID */
function dataSourceIds(layout: any): Set<string> {
  return new Set<string>((layout?.data_sources ?? []).map((ds: any) => ds.id).filter(Boolean));
}

/** 상속 체인(extends)까지 포함해 이 레이아웃에서 참조 가능한 데이터소스 ID */
function definedDataSources(entry: string, seen = new Set<string>()): Set<string> {
  const layout = parsed.get(entry);
  const ids = dataSourceIds(layout);
  const base = layout?.extends ?? layout?.meta?.extends;
  if (typeof base === 'string' && !seen.has(base)) {
    seen.add(base);
    const baseEntry = base.endsWith('.json') ? base : `${base}.json`;
    for (const id of definedDataSources(baseEntry, seen)) ids.add(id);
  }
  return ids;
}

/** 이 레이아웃이 포함하는 partial 경로 (중첩 partial 은 재귀로 펼친다) */
function directPartials(layout: any): string[] {
  const found: string[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.partial === 'string') found.push(node.partial);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(layout);
  return found;
}

function expandPartials(entry: string, seen = new Set<string>()): string[] {
  const layout = parsed.get(entry);
  if (!layout) return [];
  const result: string[] = [];
  for (const p of directPartials(layout)) {
    if (seen.has(p)) continue;
    seen.add(p);
    result.push(p, ...expandPartials(p, seen));
  }
  return result;
}

/** 표현식에서 참조하는 루트 식별자 추출 (`a?.b`, `a.b`, `a[` 모두 a 로 환원) */
function rootIdentifiers(text: string): Set<string> {
  const ids = new Set<string>();
  const bindings = text.match(/\{\{[\s\S]*?\}\}/g) ?? [];
  for (const binding of bindings) {
    // `$t:foo.bar` 는 다국어 키다 — 점 표기가 같아도 데이터 참조가 아니다
    const inner = binding.slice(2, -2).replace(/\$t:[\w.]+/g, '');
    for (const m of inner.matchAll(/(^|[^\w$.?])([A-Za-z_$][\w$]*)\s*(\??\.|\[)/g)) {
      ids.add(m[2]);
    }
  }
  return ids;
}

/**
 * partial 안에서 자체적으로 이름이 묶이는 식별자.
 * 반복 렌더링 변수와 화살표 함수 파라미터는 데이터소스와 이름이 겹쳐도 참조가 아니다.
 */
function locallyBoundNames(partial: any): Set<string> {
  const bound = new Set<string>();
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.iteration) {
      if (typeof node.iteration.item_var === 'string') bound.add(node.iteration.item_var);
      if (typeof node.iteration.index_var === 'string') bound.add(node.iteration.index_var);
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(partial);

  for (const text of collectStrings(partial)) {
    // (a, b) => ... / a => ...
    for (const m of text.matchAll(/\(([^()]*)\)\s*=>/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().replace(/[^\w$].*$/, '');
        if (name) bound.add(name);
      }
    }
    for (const m of text.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) bound.add(m[2]);
    // const x = ... (표현식 내부 지역 변수)
    for (const m of text.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1]);
  }
  return bound;
}

/** 부모 레이아웃과 그 부모가 펼치는 모든 partial 에서 이름이 묶이는 식별자 */
function boundNamesInTree(entry: string): Set<string> {
  const names = locallyBoundNames(parsed.get(entry));
  const base = parsed.get(entry)?.extends;
  if (typeof base === 'string') {
    const baseEntry = base.endsWith('.json') ? base : `${base}.json`;
    for (const n of locallyBoundNames(parsed.get(baseEntry))) names.add(n);
    for (const p of expandPartials(baseEntry)) {
      for (const n of locallyBoundNames(parsed.get(p))) names.add(n);
    }
  }
  for (const p of expandPartials(entry)) {
    for (const n of locallyBoundNames(parsed.get(p))) names.add(n);
  }
  return names;
}

// 템플릿 전체에서 한 번이라도 데이터소스 ID 로 쓰인 이름
const allDataSourceIds = new Set<string>();
for (const layout of parsed.values()) {
  for (const id of dataSourceIds(layout)) allDataSourceIds.add(id);
}

// partial → 그 partial 을 (직접/간접) 포함하는 최상위 레이아웃 목록
const includers = new Map<string, string[]>();
for (const [entry, layout] of parsed.entries()) {
  if (layout?.meta?.is_partial) continue;
  for (const p of expandPartials(entry)) {
    if (!includers.has(p)) includers.set(p, []);
    includers.get(p)!.push(entry);
  }
}

/**
 * 의도적으로 허용하는 조합.
 * 비회원 주문에는 회원 주소록이 없다 — 저장 주소 목록은 빈 상태 분기로 접히고 직접 입력 폼만 남는
 * 것이 설계된 동작이다. 조용히 넘기지 않고 여기에 남겨 사유를 코드에 기록한다.
 */
const ALLOWED_MISSING = new Set<string>([
  'partials/mypage/orders/_modal_change_address.json → shop/guest_order_show.json → userAddresses',
]);

describe('공유 partial ↔ 데이터소스 계약 (#519)', () => {
  it('템플릿에 데이터소스와 partial 이 실제로 수집되어야 함 (스캔 자체의 공회전 방지)', () => {
    expect(allDataSourceIds.size).toBeGreaterThan(10);
    expect(includers.size).toBeGreaterThan(10);
  });

  it('partial 이 참조하는 데이터소스는 그 partial 을 포함하는 모든 레이아웃에 정의되어야 함', () => {
    const violations: string[] = [];

    for (const [partialPath, parents] of includers.entries()) {
      const partial = parsed.get(partialPath);
      if (!partial) continue;

      const referenced = new Set<string>();
      for (const text of collectStrings(partial)) {
        for (const id of rootIdentifiers(text)) {
          if (allDataSourceIds.has(id)) referenced.add(id);
        }
      }
      if (referenced.size === 0) continue;

      for (const parent of parents) {
        const defined = definedDataSources(parent);
        // 함께 렌더되는 트리(부모 + 그 부모가 펼치는 모든 partial)에서 이름이 묶이면 참조가 아니다
        const bound = boundNamesInTree(parent);

        for (const id of referenced) {
          if (defined.has(id) || bound.has(id)) continue;
          if (ALLOWED_MISSING.has(`${partialPath} → ${parent} → ${id}`)) continue;
          violations.push(`${partialPath} 가 "${id}" 를 참조하지만 ${parent} 에 그 데이터소스가 없음`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

describe('쇼핑 섹션 partial 은 데이터소스 이름이 아니라 $computed 를 읽어야 함 (#519 F4)', () => {
  /**
   * 섹션 partial(최근 본 상품 / 인기 상품 / 신상품)은 여러 화면이 재사용한다.
   * 데이터소스 이름에 직결하면 그 이름을 가진 화면에서만 동작하고, 다른 화면에서는
   * `?? []` 폴백에 걸려 예외도 로그도 없이 섹션이 통째로 사라진다.
   * 그래서 값 전달은 부모가 정의한 $computed 로만 한다.
   */
  const sectionPartials = Array.from(parsed.keys()).filter(
    (entry) => entry.startsWith('partials/shop/list/_') && entry.endsWith('_products.json')
  );

  it('검사 대상 섹션 partial 이 실제로 수집되어야 함', () => {
    expect(sectionPartials.length).toBeGreaterThanOrEqual(3);
  });

  it.each(sectionPartials)('%s 이 데이터소스 ID 를 직접 참조하지 않아야 함', (entry) => {
    const referenced = new Set<string>();
    for (const text of collectStrings(parsed.get(entry))) {
      for (const id of rootIdentifiers(text)) {
        if (allDataSourceIds.has(id)) referenced.add(id);
      }
    }

    expect(Array.from(referenced)).toEqual([]);
  });

  it.each(sectionPartials)('%s 이 $computed 로 목록을 받아야 함', (entry) => {
    const texts = collectStrings(parsed.get(entry)).join('\n');

    expect(texts).toContain('$computed.');
  });
});

describe('상품 그리드 페이저 — 총 건수가 부정확해도 다음 페이지가 열려 있어야 함 (#519)', () => {
  const grid = parsed.get('partials/shop/list/_product_grid.json');

  /** 조건에 맞는 노드를 재귀 탐색 */
  function findNodes(node: any, predicate: (n: any) => boolean, acc: any[] = []): any[] {
    if (!node || typeof node !== 'object') return acc;
    if (predicate(node)) acc.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((v) => findNodes(v, predicate, acc));
      else if (value && typeof value === 'object') findNodes(value, predicate, acc);
    }
    return acc;
  }

  it('페이저 노출 조건이 last_page 단독 비교가 아니어야 함 (null 이면 접힌다)', () => {
    const pager = findNodes(grid, (n) => typeof n.comment === 'string' && n.comment.startsWith('페이지네이션'))[0];
    expect(pager).toBeDefined();
    expect(pager.if).toContain('has_more_pages');
  });

  it('다음 버튼 비활성 판정이 has_more_pages 를 근거로 해야 함', () => {
    const next = findNodes(grid, (n) => n.comment === '다음 페이지 버튼')[0];
    expect(next).toBeDefined();
    expect(next.props.disabled).toContain('has_more_pages');
    // last_page 와 current_page 를 비교하는 종전 판정이 남아 있으면 null 에서 항상 비활성이 된다
    expect(next.props.disabled).not.toContain('last_page');
  });

  it('총 건수가 부정확하면 마지막 페이지 번호를 단정하지 않아야 함', () => {
    const label = findNodes(grid, (n) => n.comment === '페이지 번호 표시')[0];
    expect(label).toBeDefined();
    expect(label.text).not.toMatch(/last_page\s*\?\?\s*1/);
  });
});
