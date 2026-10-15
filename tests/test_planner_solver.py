"""剩下的額度與「從食物庫配」的解題器（營養素配餐規格 §3、§4）。純函式，不碰資料庫。"""

import random
import time
from decimal import Decimal
from types import SimpleNamespace

from app import planner
from app.nutrition import Macros, scale
from app.planner import (
    Candidate,
    Remaining,
    is_full,
    remaining_for,
    suggest_combos,
)


def _m(kcal: str, protein: str = "0", fat: str = "0", carb: str = "0") -> Macros:
    return Macros(Decimal(kcal), Decimal(protein), Decimal(fat), Decimal(carb))


def _c(kcal: str, protein: str, fat: str, carb: str, portion: str | None = None) -> Candidate:
    return Candidate(
        per_100=_m(kcal, protein, fat, carb),
        portion_grams=None if portion is None else Decimal(portion),
    )


def _kcal_only(kcal: str) -> Remaining:
    return Remaining(kcal=Decimal(kcal), protein_g=None, fat_g=None, carb_g=None)


def _summary(combos) -> list[list[tuple[int, str, str]]]:
    """每一組：(第幾個候選, 量, quantity_g)。"""
    return [
        [(c.candidate, str(c.quantity), str(c.quantity_g)) for c in combo.choices]
        for combo in combos
    ]


# 規格 §4.5 的八樣（每 100 g／ml；有份量的是預設份量的 g）。
EIGHT = [
    _c("183", "3.1", "0.3", "41", "200"),  # 0 白飯 1 碗
    _c("210", "20", "13", "3", "150"),  # 1 滷雞腿 1 隻
    _c("140", "12.5", "9.5", "1.5", "55"),  # 2 茶葉蛋 1 顆
    _c("35", "3.6", "1.9", "0.7", "450"),  # 3 無糖豆漿 1 杯
    _c("380", "13", "7", "66"),  # 4 燕麥
    _c("180", "24", "9", "0"),  # 5 鮪魚罐頭
    _c("80", "8", "4.5", "2"),  # 6 板豆腐
    _c("25", "1.5", "0.3", "4"),  # 7 燙青菜
]
DINNER = Remaining(
    kcal=Decimal("650.00"),
    protein_g=Decimal("45.00"),
    fat_g=Decimal("20.00"),
    carb_g=Decimal("70.00"),
)


# ── 剩下的額度（規格 §3） ─────────────────────────────────────────────────────


def test_remaining_subtracts_what_was_eaten_and_never_goes_below_zero():
    remaining = remaining_for(
        kcal_budget=Decimal("2000.00"),
        protein_target=Decimal("90.00"),
        fat_target=Decimal("60.00"),
        carb_target=None,
        actual=_m("1500", "100", "30", "120"),
    )
    assert remaining == Remaining(
        kcal=Decimal("500.00"),
        protein_g=Decimal("0.00"),  # 超過了：夾在 0，仍然「考慮」
        fat_g=Decimal("30.00"),
        carb_g=None,  # 沒設目標：不考慮
    )


def test_kcal_over_the_budget_is_zero():
    remaining = remaining_for(
        kcal_budget=Decimal("1000.00"),
        protein_target=None,
        fat_target=None,
        carb_target=None,
        actual=_m("1200.50"),
    )
    assert remaining is not None and remaining.kcal == Decimal("0.00")


def test_no_kcal_budget_means_nothing_to_plan():
    assert (
        remaining_for(
            kcal_budget=None,
            protein_target=Decimal("90"),
            fat_target=None,
            carb_target=None,
            actual=_m("0"),
        )
        is None
    )


def test_a_macro_target_of_zero_is_not_considered():
    """規格 D2：0 跟沒設一樣（同 /stats/daily 的 ratio）。"""
    remaining = remaining_for(
        kcal_budget=Decimal("2000"),
        protein_target=Decimal("0"),
        fat_target=Decimal("0.00"),
        carb_target=Decimal("250"),
        actual=_m("0"),
    )
    assert remaining is not None
    assert (remaining.protein_g, remaining.fat_g) == (None, None)
    assert remaining.carb_g == Decimal("250.00")


def test_full_is_below_fifty_kcal():
    assert is_full(_kcal_only("49.99"))
    assert not is_full(_kcal_only("50.00"))
    assert suggest_combos(EIGHT, _kcal_only("49.99")) == []


# ── 每一樣的數字跟 scale() 一樣（規格 D10） ─────────────────────────────────


def test_integer_scaling_matches_nutrition_scale():
    rng = random.Random(20261015)
    for _ in range(2000):
        per_100 = Decimal(rng.randint(0, 99_999_999)) / 100
        grams = Decimal(rng.randint(1, 999_999)) / 100
        revision = SimpleNamespace(kcal=per_100, protein_g=per_100, fat_g=per_100, carb_g=per_100)
        expected = scale(revision, grams).kcal
        got = planner._from_cents(planner._scaled(planner._cents(per_100), planner._cents(grams)))
        assert got == expected, (per_100, grams)


# ── 量的步進（規格 D8）與硬限制（D7） ──────────────────────────────────────


def test_a_food_with_a_default_portion_steps_by_half_servings():
    rice = [_c("180", "3", "0.5", "40", "200")]
    one = suggest_combos(rice, _kcal_only("360"))[0].choices[0]
    half = suggest_combos(rice, _kcal_only("180"))[0].choices[0]
    assert (one.quantity, one.quantity_g, one.macros.kcal) == (
        Decimal(1), Decimal("200.00"), Decimal("360.00"),
    )  # fmt: skip
    assert (half.quantity, half.quantity_g) == (Decimal("0.5"), Decimal("100.00"))
    assert str(half.quantity) == "0.5"  # 送進記一餐的字串


def test_a_food_without_a_portion_steps_by_25_up_to_400():
    plain = [_c("100", "0", "0", "0")]
    assert suggest_combos(plain, _kcal_only("275"))[0].choices[0].quantity == Decimal(275)
    assert suggest_combos(plain, _kcal_only("1000"))[0].choices[0].quantity == Decimal(400)


def test_the_kcal_cap_is_105_percent_inclusive():
    # 25 g × 420/100 = 105.00：剛好等於 100 × 1.05，放行；424 → 106.00，擋下。
    assert _summary(suggest_combos([_c("420", "0", "0", "0")], _kcal_only("100"))) == [
        [(0, "25", "25.00")]
    ]
    assert suggest_combos([_c("424", "0", "0", "0")], _kcal_only("100")) == []


def test_every_combo_stays_under_the_cap():
    for combo in suggest_combos(EIGHT, DINNER):
        assert combo.total.kcal <= DINNER.kcal * Decimal("1.05")


# ── 目標函數（D5）：只考慮熱量時、蛋白質已經超標時 ───────────────────────────


def test_with_only_kcal_considered_protein_does_not_matter():
    """兩個都剛好 300 kcal：只看熱量時平手，候選順序決定（高蛋白在前）。"""
    foods = [_c("100", "50", "0", "0"), _c("100", "0", "0", "0")]
    assert _summary(suggest_combos(foods, _kcal_only("300")))[:2] == [
        [(0, "300", "300.00")],
        [(1, "300", "300.00")],
    ]


def test_protein_already_met_pushes_protein_away():
    """蛋白質剩 0（仍然考慮，分母 10 g）：沒有蛋白質的那個贏。"""
    foods = [_c("100", "50", "0", "0"), _c("100", "0", "0", "0")]
    remaining = Remaining(kcal=Decimal("300"), protein_g=Decimal("0"), fat_g=None, carb_g=None)
    assert _summary(suggest_combos(foods, remaining))[0] == [(1, "300", "300.00")]


# ── 規格 §4.5 的八樣：完整輸出（D6、D9、D11 一起） ──────────────────────────


def test_the_eight_foods_dinner():
    combos = suggest_combos(EIGHT, DINNER)
    assert _summary(combos) == [
        [(4, "100", "100.00"), (5, "150", "150.00")],  # 燕麥 ＋ 鮪魚罐頭
        [(4, "100", "100.00"), (6, "350", "350.00")],  # 燕麥 ＋ 板豆腐
        [(0, "1", "200.00"), (5, "175", "175.00")],  # 白飯 1 碗 ＋ 鮪魚罐頭
    ]
    first = combos[0]
    assert first.total == _m("650.00", "49.00", "20.50", "66.00")
    assert first.choices[1].macros == _m("270.00", "36.00", "13.50", "0.00")
    assert combos[2].total == _m("681.00", "48.20", "16.35", "82.00")


def test_combos_share_at_most_one_food_and_a_food_is_in_at_most_two():
    combos = suggest_combos(EIGHT, DINNER)
    sets = [{c.candidate for c in combo.choices} for combo in combos]
    for i, first in enumerate(sets):
        for second in sets[i + 1 :]:
            assert len(first & second) <= 1
    for food in range(len(EIGHT)):
        assert sum(food in s for s in sets) <= 2
    for combo in combos:
        assert len({c.candidate for c in combo.choices}) == len(combo.choices)  # 不重複食物


def test_a_combo_one_item_short_of_a_picked_one_is_skipped():
    """D11 第一條單獨的守衛（八樣的例子裡第二條也擋得住同一組，所以那條測試分不出來）。
    只看熱量剩 850：A+B+C 各 400 g＝840（0.0401）最好；A+B＝680（0.06）排第二，但跟第一組
    共用兩樣，跳過；A+C、B+C 同理。第二組是 A 單樣（520，0.151）。"""
    foods = [_c("130", "0", "0", "0"), _c("40", "0", "0", "0"), _c("40", "0", "0", "0")]
    assert _summary(suggest_combos(foods, _kcal_only("850"))) == [
        [(0, "400", "400.00"), (1, "400", "400.00"), (2, "400", "400.00")],
        [(0, "400", "400.00")],
        [(1, "400", "400.00")],
    ]


def test_an_extra_item_has_to_earn_its_place():
    """D6：A 400 g 差 10 kcal（410 的 2.4%），加 B 補滿只少了 0.0006 的分數，不值 0.02。"""
    foods = [_c("100", "0", "0", "0"), _c("40", "0", "0", "0")]
    combos = suggest_combos(foods, _kcal_only("410"))
    assert _summary(combos)[0] == [(0, "400", "400.00")]
    assert _summary(combos)[1] == [(0, "250", "250.00"), (1, "400", "400.00")]


def test_the_e2e_pair():
    """e2e 用的那一組（規格 §4.5、§9.3）：雞胸 ＋ 白飯 1 碗 200 g，剩 700 kcal、蛋白質 50。"""
    foods = [_c("110", "23", "1.5", "0"), _c("180", "3", "0.5", "40", "200")]
    remaining = Remaining(kcal=Decimal("700"), protein_g=Decimal("50"), fat_g=None, carb_g=None)
    combos = suggest_combos(foods, remaining)
    assert _summary(combos) == [
        [(0, "175", "175.00"), (1, "1.5", "300.00")],
        [(0, "250", "250.00")],
        [(1, "2", "400.00")],
    ]
    assert combos[0].total == _m("732.50", "49.25", "4.13", "120.00")


def test_a_food_with_almost_no_energy_is_never_suggested():
    """審查後的修正 M1：黑咖啡（每 100 ml 2 kcal）加進任何一組只多 0.02 的代價，單獨一組的分數
    跟「什麼都不吃」一樣——以前三組是「雞胸 250 g」「雞胸 ＋ 黑咖啡 400 ml」「黑咖啡 400 ml」。"""
    foods = [_c("110", "23", "1.5", "0"), _c("2", "0.3", "0", "0")]
    remaining = Remaining(kcal=Decimal("700"), protein_g=Decimal("50"), fat_g=None, carb_g=None)
    assert _summary(suggest_combos(foods, remaining)) == [[(0, "250", "250.00")]]


def test_the_energy_floor_is_five_kcal_per_100():
    """每 100 g／ml 不到 5 kcal 的不當候選；剛好 5 的還是（有份量的也看每 100）。"""
    assert suggest_combos([_c("4.99", "0", "0", "0")], _kcal_only("100")) == []
    assert suggest_combos([_c("4.99", "0", "0", "0", "250")], _kcal_only("100")) == []
    assert _summary(suggest_combos([_c("5", "0", "0", "0")], _kcal_only("100"))) == [
        [(0, "400", "400.00")]
    ]


def test_no_candidates_means_no_combos():
    assert suggest_combos([], DINNER) == []


# ── 確定性與時間（D10、規格 §4.5） ─────────────────────────────────────────


def test_the_same_input_gives_the_same_output():
    assert suggest_combos(EIGHT, DINNER) == suggest_combos(list(EIGHT), DINNER)


def test_thirty_gram_based_candidates_finish_well_under_200_ms():
    """最壞情況：30 個都沒有份量（每個 16 格）、剩很多。寫計畫時 17 ms；上限給 200 ms。"""
    rng = random.Random(7)
    foods = [
        _c(str(rng.randint(20, 600)), str(rng.randint(0, 30)), str(rng.randint(0, 50)),
           str(rng.randint(0, 80)))
        for _ in range(30)
    ]  # fmt: skip
    remaining = Remaining(
        kcal=Decimal("2500"), protein_g=Decimal("150"), fat_g=Decimal("80"), carb_g=Decimal("300")
    )
    started = time.perf_counter()
    combos = suggest_combos(foods, remaining)
    elapsed_ms = (time.perf_counter() - started) * 1000
    assert 1 <= len(combos) <= 3
    assert elapsed_ms < 200, elapsed_ms
