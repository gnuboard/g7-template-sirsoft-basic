/**
 * 주문서 입금 기한 안내 — 서버 SSoT 바인딩 계약 테스트 (#493 E1)
 *
 * 배경: 입금 기한은 결제수단과 무관하게 관리자 환경설정의 미입금 자동취소 기한
 *   (`order_settings.auto_cancel_days`) 하나만 사용한다. 서버는 가상계좌·무통장입금
 *   양쪽 모두 이 값으로 `vbank_due_at` / `deposit_due_at` 을 계산한다
 *   (`OrderProcessingService`). 클라이언트가 보낸 기한 값은 무시된다.
 *
 * 결함: 주문서 화면은 서버에 존재하지 않는 `vbank_due_days` / `dbank_due_days` 를
 *   참조하고 있었다. 두 키는 설정 응답에 없으므로 표현식이 항상 `undefined` 가 되고
 *   하드코딩된 폴백(가상계좌 3, 무통장입금 7)이 그대로 노출됐다.
 *
 *   실측(2026-07-29): `auto_cancel_days = 3` 인 사이트에서 무통장입금 주문서가
 *   "입금 기한: 7일 이내" 로 안내했다. 실제로는 3일 뒤 자동취소된다 —
 *   안내를 믿은 구매자는 주문이 취소된 뒤에야 알게 된다.
 *
 * 회귀 차단 포인트:
 *   1. 두 안내 모두 `order_settings.auto_cancel_days` 를 참조한다.
 *   2. 서버에 없는 `*_due_days` 키를 참조하지 않는다 (되살아나면 폴백으로 조용히 회귀).
 *   3. 폴백 값은 서버 기본치(3)와 같다 — 설정 응답이 늦거나 실패해도 안내가 어긋나지 않도록.
 */

import { describe, it, expect } from 'vitest';

import checkoutPayment from '../../layouts/partials/shop/_checkout_payment.json';

const raw = JSON.stringify(checkoutPayment);

/** 서버 SSoT 표현식 — 결제수단 무관 단일 기준 */
const SSOT_EXPRESSION = 'paymentSettings.data?.order_settings?.auto_cancel_days ?? 3';

describe('주문서 입금 기한 안내 — 서버 SSoT 바인딩 (#493 E1)', () => {
    it.each([
        ['가상계좌', 'vbank_due_notice'],
        ['무통장입금', 'dbank_due_notice'],
    ])('%s 안내가 auto_cancel_days 를 참조한다', (_label, translationKey) => {
        const entry = raw.match(new RegExp(`\\$t:shop\\.checkout\\.${translationKey}\\|days=[^"]*`))?.[0];

        expect(entry, `${translationKey} 안내 문구를 찾지 못했습니다`).toBeDefined();
        expect(entry).toContain(SSOT_EXPRESSION);
    });

    it.each([
        ['vbank_due_days'],
        ['dbank_due_days'],
    ])('서버에 없는 %s 키를 참조하지 않는다', (orphanKey) => {
        expect(
            raw.includes(orphanKey),
            `${orphanKey} 는 설정 응답에 존재하지 않는 키입니다 — 표현식이 항상 undefined 가 되어 하드코딩 폴백이 노출됩니다.`
        ).toBe(false);
    });
});
