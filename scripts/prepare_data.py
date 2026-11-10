"""Generate the Ledger public demo without reading an external dataset."""
from collections import Counter, defaultdict
from datetime import date, timedelta
import hashlib
import json
from pathlib import Path
from random import Random

ROOT = Path(__file__).resolve().parents[1]
SEED = 417
VERSION = "ledger-synthetic-v1"
START = date(2024, 8, 1)
END = date(2025, 7, 31)
CUSTOMER_COUNT = 480


def generate():
    rng = Random(SEED)
    customers = []
    transactions = []
    for index in range(CUSTOMER_COUNT):
        customer_id = f"CUST{100000 + index}"
        account = rng.choices(["savings", "current"], [8, 2])[0]
        opening = START - timedelta(days=rng.randint(25, 1000))
        balance = rng.randint(2_500, 90_000) * 100
        customers.append([
            customer_id, f"BR{index % 18 + 1:03}", rng.randint(20, 79),
            rng.choice(["F", "M", "X"]), rng.choice(["low", "middle", "high"]),
            rng.choices(["online", "branch"], [7, 3])[0], account,
            rng.choices(["complete", "pending"], [94, 6])[0], opening.isoformat(), balance,
        ])
        # Cohorts make retention meaningful and leave some clients dormant.
        active_through = 5 if index % 11 == 0 else 12
        engagement = rng.uniform(.45, .96)
        for offset in range(active_through):
            year, month = divmod(START.year * 12 + START.month - 1 + offset, 12)
            if offset and rng.random() > engagement:
                continue
            for _ in range(rng.randint(1, 4)):
                day = rng.randint(1, 28)
                if index == 1 and offset == 11:
                    day = END.day
                kind = rng.choices(["deposit", "withdrawal"], [6, 4])[0]
                amount = rng.randint(250, 12_000 if account == "savings" else 30_000) * 100
                if kind == "withdrawal":
                    amount = -amount
                transactions.append([f"SYN{len(transactions)+1:06}", customer_id,
                                     date(year, month + 1, day).isoformat(), amount, kind, "baseline"])
    transactions.sort(key=lambda row: (row[2], row[0]))
    return {"version": VERSION, "customers": customers, "transactions": transactions}


def audit(seed, encoded):
    customers, transactions = seed["customers"], seed["transactions"]
    by_id = {row[0]: row for row in customers}
    assert len(by_id) == len(customers)
    assert len({row[0] for row in transactions}) == len(transactions)
    activity, latest, net = defaultdict(set), {}, Counter()
    for _, customer, day, amount, kind, source in transactions:
        assert customer in by_id and START <= date.fromisoformat(day) <= END
        assert day >= by_id[customer][8] and source == "baseline"
        assert amount != 0 and (amount > 0) == (kind == "deposit")
        latest[customer] = max(latest.get(customer, day), day)
        activity[day[:7]].add(customer)
        net[customer] += amount
    assert len(latest) == len(customers) and max(latest.values()) == END.isoformat()
    balance = {key: row[9] + net[key] for key, row in by_id.items()}
    july, june = activity["2025-07"], activity["2025-06"]
    return {
        "dataset": VERSION,
        "generator_seed": SEED,
        "sha256": hashlib.sha256(encoded).hexdigest(),
        "provenance": "Deterministically generated fictional clients and transactions. No third-party records.",
        "currency": "INR",
        "start_date": START.isoformat(),
        "as_of": END.isoformat(),
        "customers": len(customers),
        "transactions": len(transactions),
        "balance_minor": sum(balance.values()),
        "inactive_180": sum((END - date.fromisoformat(day)).days >= 180 for day in latest.values()),
        "pending_kyc": sum(row[7] == "pending" for row in customers),
        "negative_balances": sum(amount < 0 for amount in balance.values()),
        "july_active": len(july),
        "june_active": len(june),
        "july_returning": len(july & june),
        "july_retention": round(100 * len(july & june) / len(june), 2),
        "deposits_minor": sum(max(row[3], 0) for row in transactions),
        "withdrawals_minor": sum(max(-row[3], 0) for row in transactions),
        "checks": ["Unique keys", "Valid client references and dates", "Signed amounts", "All clients have recorded activity"],
    }


if __name__ == "__main__":
    seed = generate()
    encoded = json.dumps(seed, separators=(",", ":")).encode("utf-8")
    summary = audit(seed, encoded)
    (ROOT / "data" / "seed.json").write_bytes(encoded)
    (ROOT / "data" / "audit.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))
