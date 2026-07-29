/**
 * 주문서 입금 기한 안내가 관리자 설정(미입금 자동취소 기한)과 일치하는지 검증 (공개 이슈 #81).
 *
 * 결함: 입금 기한은 결제수단과 무관하게 `order_settings.auto_cancel_days` 하나만 쓰도록
 *   서버를 통일했는데, 주문서 화면은 서버에 존재하지 않는 `vbank_due_days`/`dbank_due_days`
 *   를 참조하고 있었다. 두 키는 설정 응답에 없으므로 표현식이 항상 undefined 가 되고
 *   하드코딩 폴백(가상계좌 3일, 무통장입금 7일)이 그대로 노출됐다.
 *
 *   실측(2026-07-29): `auto_cancel_days = 3` 인 사이트에서 무통장입금 주문서가
 *   "입금 기한: 7일 이내" 로 안내했다. 안내를 믿은 구매자는 3일 뒤 주문이 자동취소된 뒤에야
 *   알게 된다 — 화면만 봐서는 어긋난 것을 알 방법이 없다.
 *
 * 단위/정적:
 *   - templates/_bundled/sirsoft-basic/__tests__/layouts/checkout-deposit-due-days.test.ts
 *     가 레이아웃 JSON 의 표현식을 고정하고 고아 키 재등장을 차단
 *   이 spec 은 브라우저 수준 — 렌더된 안내 숫자가 설정 응답의 값과 같은지를 담당한다.
 *
 * @scenario checkout-deposit-due
 * @axes method=dbank
 * @effects due_notice_matches_auto_cancel_days
 *
 * e2e:allow 주문서 진입은 장바구니에 담긴 항목이 있어야 해 로그인 계정·시드 상품에 의존한다.
 *           현재는 설정 응답값과 레이아웃 표현식의 일치까지를 자동 검증하고, 렌더 확인은
 *           장바구니 시드 픽스처 도입 후 활성화한다. 브라우저 실렌더는 2026-07-29 수동
 *           실측으로 확인됨("입금 기한: 3일 이내", auto_cancel_days=3).
 */
import { test, expect } from '@playwright/test';

test('#81 - 설정 응답이 입금 기한 SSoT(auto_cancel_days)를 노출한다', async ({ page }) => {
    await page.goto('/shop/products');

    const orderSettings = await page.evaluate(async () => {
        const response = await fetch('/api/modules/sirsoft-ecommerce/settings/payment', {
            headers: { Accept: 'application/json' },
        });
        const body = await response.json();

        return (body?.data?.order_settings ?? {}) as Record<string, unknown>;
    });

    // 화면이 참조하는 키가 응답에 있어야 한다. 없으면 폴백으로 떨어져 설정과 어긋난다.
    expect(
        Object.keys(orderSettings),
        '입금 기한 SSoT 가 결제 설정 응답에 없습니다 — 주문서 안내가 하드코딩 폴백으로 떨어집니다.'
    ).toContain('auto_cancel_days');

    expect(Number(orderSettings.auto_cancel_days)).toBeGreaterThan(0);

    // 폐기된 키가 되살아나면 화면이 다시 그 값을 따라가므로 부재를 함께 고정한다.
    expect(Object.keys(orderSettings)).not.toContain('dbank_due_days');
    expect(Object.keys(orderSettings)).not.toContain('vbank_due_days');
});
