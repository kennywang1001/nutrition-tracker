"""今天還能吃什麼：剩下的額度與「從食物庫配」的解題器（營養素配餐規格 §3、§4）。

純函式：不碰資料庫、不碰時間、不寫 log（`tests/test_planner_privacy.py` 掃這個檔案）。
營養素一律換成「分」（×100 的整數）運算，分數也是整數——同樣的輸入永遠是同樣的輸出，
跟平台無關（規格 D10）。
"""

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from app.nutrition import Macros

_CENTS = Decimal("0.01")
_ZERO = Decimal("0.00")

# 剩下的熱量低於這個數字＝今天差不多吃滿了，不給建議（規格 D4）。
FULL_BELOW_KCAL = Decimal(50)

# 量的步進（規格 D8）：有預設份量的食物用「幾份」，沒有的用 g／ml。
SERVING_STEPS: tuple[Decimal, ...] = (Decimal("0.5"), Decimal(1), Decimal("1.5"), Decimal(2))
GRAM_STEPS: tuple[Decimal, ...] = tuple(Decimal(g) for g in range(25, 401, 25))

# 目標函數（規格 D5）：Σ 權重 ×（(合計 − 剩下) / 分母)²。權重 ×100 成整數：
# 熱量 1.0、蛋白質 1.0、脂肪 0.5、碳水 0.5。
_WEIGHTS: tuple[int, int, int, int] = (100, 100, 50, 50)
# 三大營養素剩下的量很少（或 0）時，分母至少 10 g（1000 分）：不然多 1 g 就是無限大的
# 誤差。熱量不用：剩不到 50 kcal 根本不會解題。
_MACRO_FLOOR_CENTS = 1000
# 多一樣食物要多 0.02 的分數才划算（同權重的 ×100；規格 D6）。
_ITEM_PENALTY = 2
# 硬限制（規格 D7）：合計熱量 ≤ 剩下的 × 105 / 100。
_KCAL_CAP_PERCENT = 105
# 每 100 g／ml 不到 5 kcal 的食物（黑咖啡、茶、水、零卡飲料）不當候選（審查後的修正 M1）：
# 它們加進任何一組只多一個代價（D6），單獨一組的分數跟「什麼都不吃」一樣——三組裡會出現
# 「X ＋ 黑咖啡 25 ml」「黑咖啡 25 ml」這種沒用的建議。400 g 也不到 20 kcal，不是「一餐」。
MIN_KCAL_PER_100 = Decimal(5)

TOP_SINGLES = 12  # 兩樣、三樣只在單樣最好的這幾個食物之間找
SEED_PAIRS = 8  # 三樣：從最好的這幾組兩樣出發，各加一樣
DESCENT_ROUNDS = 2  # 三樣的座標下降最多幾輪
MAX_COMBOS = 3


@dataclass(frozen=True)
class Remaining:
    """今天還能吃多少。三大營養素是 `None`＝沒設目標（或目標是 0），不考慮。"""

    kcal: Decimal
    protein_g: Decimal | None
    fat_g: Decimal | None
    carb_g: Decimal | None


def _left(target: Decimal | None, actual: Decimal) -> Decimal | None:
    # 目標 0 跟沒設一樣不考慮（同 `/stats/daily` 的 ratio：0 → null；規格 D2）。
    if target is None or target == 0:
        return None
    return max(target - actual, _ZERO).quantize(_CENTS)


def remaining_for(
    *,
    kcal_budget: Decimal | None,
    protein_target: Decimal | None,
    fat_target: Decimal | None,
    carb_target: Decimal | None,
    actual: Macros,
) -> Remaining | None:
    """剩下的＝額度（熱量）或目標（三大營養素）− 已經吃的，最少 0（規格 §3）。
    沒有熱量額度（沒有目標、或目標沒設熱量）回 `None`。"""
    if kcal_budget is None:
        return None
    return Remaining(
        kcal=max(kcal_budget - actual.kcal, _ZERO).quantize(_CENTS),
        protein_g=_left(protein_target, actual.protein_g),
        fat_g=_left(fat_target, actual.fat_g),
        carb_g=_left(carb_target, actual.carb_g),
    )


def is_full(remaining: Remaining) -> bool:
    return remaining.kcal < FULL_BELOW_KCAL


@dataclass(frozen=True)
class Candidate:
    """一個可以配的食物：每 100 g／ml 的營養素，與預設份量的重量（沒有是 `None`）。"""

    per_100: Macros
    portion_grams: Decimal | None


@dataclass(frozen=True)
class Choice:
    """組合裡的一樣：第幾個候選、量（有份量是幾份，沒有是 g／ml）、實際 g／ml、營養素。"""

    candidate: int
    quantity: Decimal
    quantity_g: Decimal
    macros: Macros


@dataclass(frozen=True)
class Combo:
    choices: tuple[Choice, ...]
    total: Macros


_Vector = tuple[int, int, int, int]
_NOTHING: _Vector = (0, 0, 0, 0)


@dataclass(frozen=True)
class _Option:
    quantity: Decimal
    quantity_g_cents: int
    vector: _Vector


def _cents(value: Decimal) -> int:
    return int((value * 100).to_integral_value(rounding=ROUND_HALF_UP))


def _from_cents(value: int) -> Decimal:
    return (Decimal(value) / 100).quantize(_CENTS)


def _scaled(per_100_cents: int, quantity_g_cents: int) -> int:
    """每 100 × 量 / 100，四捨五入到分——跟 `app/nutrition.py` 的 `scale()` 一模一樣
    （那邊是 Decimal＋ROUND_HALF_UP，這裡是整數；兩個都是非負數）。"""
    return (2 * per_100_cents * quantity_g_cents + 10000) // 20000


def _macros(vector: _Vector) -> Macros:
    return Macros(
        kcal=_from_cents(vector[0]),
        protein_g=_from_cents(vector[1]),
        fat_g=_from_cents(vector[2]),
        carb_g=_from_cents(vector[3]),
    )


def _add(left: _Vector, right: _Vector) -> _Vector:
    return (left[0] + right[0], left[1] + right[1], left[2] + right[2], left[3] + right[3])


def _options(candidate: Candidate, cap_numerator: int) -> list[_Option]:
    per = (
        _cents(candidate.per_100.kcal),
        _cents(candidate.per_100.protein_g),
        _cents(candidate.per_100.fat_g),
        _cents(candidate.per_100.carb_g),
    )
    if candidate.per_100.kcal < MIN_KCAL_PER_100:
        # 沒有選項＝不是候選；位置不變（組合裡的 `candidate` 仍是傳進來的順序）。
        return []
    if candidate.portion_grams is not None:
        grams = candidate.portion_grams
        steps = [(step, _cents(grams * step)) for step in SERVING_STEPS]
    else:
        steps = [(step, _cents(step)) for step in GRAM_STEPS]
    result = []
    for quantity, quantity_g_cents in steps:
        vector = (
            _scaled(per[0], quantity_g_cents),
            _scaled(per[1], quantity_g_cents),
            _scaled(per[2], quantity_g_cents),
            _scaled(per[3], quantity_g_cents),
        )
        # 一樣就超過上限的量，在任何組合裡都超過：先拿掉。
        if vector[0] * 100 <= cap_numerator:
            result.append(_Option(quantity, quantity_g_cents, vector))
    return result


class _Scorer:
    """Σ wᵢ (eᵢ / Dᵢ)² 乘上 Π Dⱼ² 的整數版本：大小順序完全一樣，不用除法、不用浮點數。"""

    def __init__(self, remaining: Remaining) -> None:
        targets = (remaining.kcal, remaining.protein_g, remaining.fat_g, remaining.carb_g)
        denominators: dict[int, int] = {}
        wanted: dict[int, int] = {}
        for index, value in enumerate(targets):
            if value is None:
                continue
            wanted[index] = _cents(value)
            floor = 0 if index == 0 else _MACRO_FLOOR_CENTS
            denominators[index] = max(wanted[index], floor)
        product = 1
        for denominator in denominators.values():
            product *= denominator * denominator
        self._terms = [
            (index, wanted[index], _WEIGHTS[index] * (product // denominators[index] ** 2))
            for index in denominators
        ]
        self.item_penalty = _ITEM_PENALTY * product

    def __call__(self, total: _Vector) -> int:
        score = 0
        for index, wanted, multiplier in self._terms:
            error = total[index] - wanted
            score += multiplier * error * error
        return score


# 一個食物集合 → (分數, 每個食物用第幾個選項)。食物集合是排好序的候選位置。
_Found = dict[tuple[int, ...], tuple[int, tuple[int, ...]]]


@dataclass(frozen=True)
class _Problem:
    options: list[list[_Option]]
    score: _Scorer
    cap_numerator: int

    def fits(self, total: _Vector) -> bool:
        return total[0] * 100 <= self.cap_numerator

    def total(self, chosen: dict[int, int], skip: int | None = None) -> _Vector:
        result = _NOTHING
        for food, index in chosen.items():
            if food != skip:
                result = _add(result, self.options[food][index].vector)
        return result

    def best_option(self, food: int, others: _Vector) -> tuple[int, int] | None:
        """其他的不動，這個食物最好的量：(分數, 第幾個選項)。都超過上限是 `None`。"""
        found: tuple[int, int] | None = None
        for index, option in enumerate(self.options[food]):
            total = _add(others, option.vector)
            if not self.fits(total):
                continue
            key = (self.score(total), index)
            if found is None or key < found:
                found = key
        return found


def _singles(problem: _Problem) -> _Found:
    found: _Found = {}
    for food in range(len(problem.options)):
        best = problem.best_option(food, _NOTHING)
        if best is not None:
            found[(food,)] = (best[0], (best[1],))
    return found


def _pairs(problem: _Problem, top: list[int]) -> _Found:
    found: _Found = {}
    for position, first in enumerate(top):
        for second in top[position + 1 :]:
            a, b = sorted((first, second))
            best: tuple[int, int, int] | None = None
            for index_a, option_a in enumerate(problem.options[a]):
                for index_b, option_b in enumerate(problem.options[b]):
                    total = _add(option_a.vector, option_b.vector)
                    if not problem.fits(total):
                        continue
                    key = (problem.score(total), index_a, index_b)
                    if best is None or key < best:
                        best = key
            if best is not None:
                found[(a, b)] = (best[0], (best[1], best[2]))
    return found


def _triple(
    problem: _Problem,
    seed: tuple[int, ...],
    picks: tuple[int, ...],
    third: int,
    rank: dict[int, int],
) -> tuple[int, tuple[int, ...]] | None:
    """兩樣的組合加第三樣：先挑第三樣最好的量，再輪流重挑每一樣（其他的不動），有進步才換。

    輪流的順序是 `rank`（單樣的名次），**不是**候選的位置：座標下降停在哪個局部最好跟輪流的
    順序有關，照位置輪的話同樣的食物換個順序傳進來，三樣的答案就可能不同（審查後的修正 M3）。"""
    chosen = dict(zip(seed, picks, strict=True))
    first = problem.best_option(third, problem.total(chosen))
    if first is None:
        return None
    current, chosen[third] = first
    foods = tuple(sorted(chosen))
    for _ in range(DESCENT_ROUNDS):
        improved = False
        for food in sorted(chosen, key=rank.__getitem__):
            candidate = problem.best_option(food, problem.total(chosen, skip=food))
            if candidate is not None and candidate[0] < current:
                current, chosen[food] = candidate
                improved = True
        if not improved:
            break
    return current, tuple(chosen[food] for food in foods)


def _pick(ranked: list[tuple[int, int, tuple[int, ...], tuple[int, ...]]]) -> list[
    tuple[tuple[int, ...], tuple[int, ...]]
]:
    """依序挑：跟已挑的每一組最多共用一樣、同一個食物最多出現在兩組（規格 D11）。"""
    picked: list[tuple[tuple[int, ...], tuple[int, ...]]] = []
    for _value, _size, foods, picks in ranked:
        if any(len(set(foods) & set(other)) > 1 for other, _ in picked):
            continue
        if any(sum(food in other for other, _ in picked) >= 2 for food in foods):
            continue
        picked.append((foods, picks))
        if len(picked) == MAX_COMBOS:
            break
    return picked


def suggest_combos(candidates: Sequence[Candidate], remaining: Remaining) -> list[Combo]:
    """最多 `MAX_COMBOS` 組 1～3 樣、不重複食物的組合，最好的在前（規格 §4.3）。

    ①每個食物各自最好的量；②單樣最好的 `TOP_SINGLES` 個食物兩兩窮舉所有量；③從最好的
    `SEED_PAIRS` 組兩樣出發，各加一個前 `TOP_SINGLES` 的食物、座標下降；④全部依
    「分數＋(樣數 − 1) × 代價」排序，照規格 D11 挑。平手用候選與選項的順序決定。
    """
    if is_full(remaining):
        # 剩不到 50 kcal：不解題（也讓下面的分母一定大於 0）。
        return []
    cap_numerator = _cents(remaining.kcal) * _KCAL_CAP_PERCENT
    score = _Scorer(remaining)
    problem = _Problem(
        options=[_options(candidate, cap_numerator) for candidate in candidates],
        score=score,
        cap_numerator=cap_numerator,
    )

    found = _singles(problem)
    top = sorted((foods[0] for foods in found), key=lambda food: (found[(food,)][0], food))
    top = top[:TOP_SINGLES]
    rank = {food: position for position, food in enumerate(top)}
    pairs = _pairs(problem, top)
    found.update(pairs)
    for seed in sorted(pairs, key=lambda foods: (pairs[foods][0], foods))[:SEED_PAIRS]:
        for third in top:
            foods = tuple(sorted((*seed, third)))
            if third in seed or foods in found:
                continue
            result = _triple(problem, seed, pairs[seed][1], third, rank)
            if result is not None:
                found[foods] = result

    ranked = sorted(
        (value + (len(foods) - 1) * score.item_penalty, len(foods), foods, picks)
        for foods, (value, picks) in found.items()
    )
    combos = []
    for foods, picks in _pick(ranked):
        options = [problem.options[food][pick] for food, pick in zip(foods, picks, strict=True)]
        total = _NOTHING
        for option in options:
            total = _add(total, option.vector)
        combos.append(
            Combo(
                choices=tuple(
                    Choice(
                        candidate=food,
                        quantity=option.quantity,
                        quantity_g=_from_cents(option.quantity_g_cents),
                        macros=_macros(option.vector),
                    )
                    for food, option in zip(foods, options, strict=True)
                ),
                total=_macros(total),
            )
        )
    return combos
