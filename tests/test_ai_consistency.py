from decimal import Decimal

from app.ai.consistency import check_consistency


def _c(kcal: str, protein: str, fat: str, carb: str):
    return check_consistency(
        kcal=Decimal(kcal),
        protein_g=Decimal(protein),
        fat_g=Decimal(fat),
        carb_g=Decimal(carb),
    )


def test_atwater_is_4_4_9():
    """熱量 = 4×蛋白質 + 4×碳水 + 9×脂肪。"""
    result = _c("100.00", "10.00", "0.00", "15.00")

    assert result.atwater_kcal == Decimal("100.00")
    assert result.deviation == Decimal("0.00")
    assert result.flagged is False


def test_fat_is_nine_not_four():
    """脂肪是 9 不是 4——寫錯的話這一條會紅，而上面那條（脂肪 0）不會。

    這就是為什麼上面那條刻意把脂肪設成 0：它對係數錯誤零鑑別力。
    """
    result = _c("90.00", "0.00", "10.00", "0.00")

    assert result.atwater_kcal == Decimal("90.00")
    assert result.flagged is False


def test_flags_a_large_deviation():
    # atwater = 4×10 + 4×10 + 9×0 = 80；宣稱 500 大卡
    result = _c("500.00", "10.00", "0.00", "10.00")

    assert result.flagged is True


def test_does_not_flag_small_absolute_deviation_on_low_calorie_food():
    """**規格 §2.1 的絕對下限那一條。**

    青菜：宣稱 8 大卡，atwater 算出來 5 大卡。偏差 3 大卡 = 37.5%，
    百分比門檻（25%）會標記它——但 3 大卡沒有任何意義。

    只測百分比的話這個雜訊來源完全沒被守到，而它會讓每一樣低熱量食物
    都被標記——**每一筆都被標記等於沒有標記**。
    """
    result = _c("8.00", "0.50", "0.00", "0.75")

    assert result.deviation == Decimal("3.00")
    assert result.flagged is False


def test_flags_when_both_thresholds_are_exceeded():
    """偏差同時超過 25% 與 20 大卡才標記。

    400 大卡 vs atwater 300：偏差 100，超過 max(100, 20) 嗎？
    400 × 0.25 = 100，偏差剛好 100 —— 用 `>` 所以**不標記**。
    邊界值刻意測，因為 `>` 跟 `>=` 的差別在這裡是一個真實的判斷。
    """
    boundary = _c("400.00", "25.00", "0.00", "50.00")
    assert boundary.atwater_kcal == Decimal("300.00")
    assert boundary.deviation == Decimal("100.00")
    assert boundary.flagged is False

    over = _c("401.00", "25.00", "0.00", "50.00")
    assert over.flagged is True


def test_zero_kcal_does_not_divide_by_zero():
    """宣稱 0 大卡（零卡飲料）。百分比門檻是 0，絕對下限 20 接手。"""
    result = _c("0.00", "0.00", "0.00", "0.00")

    assert result.flagged is False
