/**
 * @file board-reaction-buttons.test.tsx
 * @description 게시글 상세 반응(추천/비추천) 버튼 레이아웃 회귀 (이슈 #525)
 *
 * 검증 방식: 레이아웃 JSON 트리 직접 분석 (board 파티션 테스트 관례 — show.json 은 partial).
 * 고정 대상:
 *  - 반응 영역은 use_reaction && reaction_type_options.length > 0 일 때만 노출 (확정 11)
 *  - reaction_type_options 를 iteration 으로 순회 (확정 02·유형 동적 렌더)
 *  - 유형별 개수는 reaction_counts[유형 ID] 를 바인딩, 없으면 0 (확정 09)
 *  - 본인 글이면 버튼 disabled (확정 08)
 *  - 클릭 시 비로그인은 안내+로그인 유도, 로그인 사용자는 react API 호출 후 post 재조회 (확정 03·07)
 */

import { describe, it, expect } from 'vitest';

import basicShow from '../../layouts/partials/board/types/basic/show.json';

type Node = Record<string, unknown> & { children?: unknown };

function collectNodes(node: unknown, predicate: (n: Node) => boolean): Node[] {
    const result: Node[] = [];
    const walk = (cur: unknown): void => {
        if (Array.isArray(cur)) {
            cur.forEach(walk);
            return;
        }
        if (cur && typeof cur === 'object') {
            const obj = cur as Node;
            if (predicate(obj)) {
                result.push(obj);
            }
            Object.values(obj).forEach(walk);
        }
    };
    walk(node);
    return result;
}

function findByComment(root: unknown, commentText: string): Node[] {
    return collectNodes(root, (n) => typeof n.comment === 'string' && (n.comment as string).includes(commentText));
}

describe('이슈 #525 — 게시글 상세 반응 버튼 (basic/show.json)', () => {
    // @scenario case=detail_hidden_when_no_active_types
    // @effects reaction_area_hidden_when_no_active_types
    it('반응 영역은 use_reaction + reaction_type_options 존재 시에만 노출된다 (확정 11)', () => {
        // 이 if 는 use_reaction 과 reaction_type_options 둘 다에 의존하므로
        // reaction off / 유형 0개 두 케이스 모두 이 조건으로 미노출된다.
        // @scenario case=detail_hidden_when_use_reaction_off
        // @effects reaction_area_hidden_when_use_reaction_off
        const areas = findByComment(basicShow, '게시글 반응(추천/비추천) 영역');
        expect(areas.length).toBe(1);

        const area = areas[0];
        expect(typeof area.if).toBe('string');
        expect(area.if as string).toContain('use_reaction');
        expect(area.if as string).toContain('reaction_type_options');
        expect(area.if as string).toContain('length > 0');
    });

    // @scenario case=detail_shows_active_types_even_zero
    // @effects active_types_always_shown_even_zero_count
    it('반응 유형을 reaction_type_options 로 iteration 한다', () => {
        const areas = findByComment(basicShow, '게시글 반응(추천/비추천) 영역');
        const iterations = collectNodes(areas[0], (n) => n.iteration !== undefined);
        expect(iterations.length).toBeGreaterThan(0);

        const iter = iterations[0].iteration as Record<string, unknown>;
        expect(iter.source as string).toContain('reaction_type_options');
        expect(iter.item_var).toBe('reactionType');
    });

    // @scenario case=author_buttons_disabled
    // @effects author_sees_buttons_disabled, active_types_always_shown_even_zero_count, my_reaction_type_highlighted
    it('유형별 버튼은 본인 글이면 disabled 이고 개수를 바인딩한다 (확정 08·09)', () => {
        const areas = findByComment(basicShow, '게시글 반응(추천/비추천) 영역');
        const buttons = collectNodes(areas[0], (n) => n.name === 'Button');
        expect(buttons.length).toBeGreaterThan(0);

        const btn = buttons[0];
        const props = btn.props as Record<string, unknown>;
        expect(props.type).toBe('button');
        expect(String(props.disabled)).toContain('is_author');

        // 개수 바인딩 (reaction_counts[유형 ID] ?? 0)
        const counts = collectNodes(btn, (n) =>
            typeof n.text === 'string' && (n.text as string).includes('reaction_counts')
        );
        expect(counts.length).toBe(1);
        expect(counts[0].text as string).toContain('reactionType.id');
        expect(counts[0].text as string).toContain('?? 0');
    });

    it('클릭 액션은 비로그인/로그인 분기 — react API 호출 + post 재조회 (확정 03·07)', () => {
        const areas = findByComment(basicShow, '게시글 반응(추천/비추천) 영역');
        const buttons = collectNodes(areas[0], (n) => n.name === 'Button');
        const actions = (buttons[0].actions as Node[]) ?? [];
        expect(actions.length).toBeGreaterThan(0);

        const action = actions[0];
        expect(action.handler).toBe('switch');

        const cases = action.cases as Record<string, Node>;
        expect(cases.logged_in).toBeDefined();
        expect(cases.not_logged_in).toBeDefined();

        // 로그인 사용자: react API 호출 후 post 데이터소스 재조회
        const loggedIn = cases.logged_in;
        expect(loggedIn.handler).toBe('apiCall');
        expect(loggedIn.target as string).toContain('/react');
        const onSuccess = loggedIn.onSuccess as Node[];
        expect(onSuccess.some((a) => a.handler === 'refetchDataSource')).toBe(true);

        // 비로그인: 안내 후 로그인 유도 (redirect 파라미터 전달)
        const guest = cases.not_logged_in;
        const guestActions = guest.actions as Node[];
        expect(guestActions.some((a) => a.handler === 'toast')).toBe(true);
        const navAction = guestActions.find((a) => a.handler === 'navigate');
        expect(navAction).toBeDefined();
        const navParams = navAction!.params as Record<string, unknown>;
        expect(navParams.path).toBe('/login');
        expect((navParams.query as Record<string, unknown>).redirect).toContain('/board/');
    });
});
