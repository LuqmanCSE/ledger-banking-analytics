CREATE TABLE customers (
  customer_id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL,
  age INTEGER NOT NULL,
  gender TEXT NOT NULL,
  income_bracket TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('online','branch')),
  account_type TEXT NOT NULL CHECK(account_type IN ('savings','current')),
  kyc_status TEXT NOT NULL CHECK(kyc_status IN ('complete','pending')),
  account_open_date TEXT NOT NULL,
  initial_minor INTEGER NOT NULL,
  balance_minor INTEGER NOT NULL,
  last_txn_date TEXT
);
--> statement-breakpoint
CREATE TABLE transactions (
  transaction_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  transaction_date TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor != 0),
  transaction_type TEXT NOT NULL CHECK(transaction_type IN ('deposit','withdrawal')),
  source TEXT NOT NULL CHECK(source IN ('baseline','upload','simulated')),
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((amount_minor>0 AND transaction_type='deposit') OR (amount_minor<0 AND transaction_type='withdrawal'))
);
--> statement-breakpoint
CREATE INDEX transactions_customer_date ON transactions(customer_id,transaction_date);
--> statement-breakpoint
CREATE INDEX transactions_date ON transactions(transaction_date);
--> statement-breakpoint
CREATE INDEX transactions_received ON transactions(received_at);
--> statement-breakpoint
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE ingestion_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  accepted INTEGER NOT NULL,
  rejected INTEGER NOT NULL,
  duplicates INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE TRIGGER transaction_balance AFTER INSERT ON transactions BEGIN
  UPDATE customers SET balance_minor=balance_minor+NEW.amount_minor,
    last_txn_date=CASE WHEN last_txn_date IS NULL OR NEW.transaction_date>last_txn_date THEN NEW.transaction_date ELSE last_txn_date END
  WHERE customer_id=NEW.customer_id;
END;
