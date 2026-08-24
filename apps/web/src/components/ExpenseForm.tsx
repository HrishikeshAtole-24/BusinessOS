'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { API_URL } from '../lib/config';

interface Category {
  id: string;
  name: string;
  code: string;
  receiptRequiredAbove: string | null;
}

/**
 * File a claim.
 *
 * Amount stays a STRING the whole way (Section 28.2). Parsing it to a number
 * here to validate would reintroduce exactly the float imprecision the decimal
 * column exists to avoid.
 */
export function ExpenseForm({ categories }: { categories: Category[] }) {
  const router = useRouter();
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [spentOn, setSpentOn] = useState('');
  const [description, setDescription] = useState('');
  const [receiptKey, setReceiptKey] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const category = categories.find((c) => c.id === categoryId);
  const needsReceipt =
    category?.receiptRequiredAbove != null &&
    amount !== '' &&
    Number(amount) > Number(category.receiptRequiredAbove);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const response = await fetch(`${API_URL}/v1/expenses`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          categoryId,
          amount,
          spentOn,
          description,
          ...(receiptKey.trim() ? { receiptKey: receiptKey.trim() } : {}),
        }),
      });
      const body = (await response.json()) as { error?: { message: string } };
      if (!response.ok) {
        setError(body.error?.message ?? 'Could not create the claim.');
        return;
      }
      setAmount('');
      setDescription('');
      setReceiptKey('');
      router.refresh();
    } catch {
      setError('Cannot reach the API.');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">New claim</h2>
        <span className="subtle" style={{ fontSize: 'var(--text-sm)' }}>
          Saved as a draft — submit it to start the approval chain
        </span>
      </div>
      <form className="card-body stack" onSubmit={handleSubmit}>
        {error ? (
          <div className="alert alert-danger" role="alert">
            {error}
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: '1 1 160px' }}>
            <label className="label" htmlFor="expense-category">
              Category
            </label>
            <select
              id="expense-category"
              className="input"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field" style={{ flex: '1 1 130px' }}>
            <label className="label" htmlFor="expense-amount">
              Amount (INR)
            </label>
            <input
              id="expense-amount"
              className="input"
              inputMode="decimal"
              required
              value={amount}
              placeholder="1800.00"
              pattern="\d{1,12}(\.\d{1,2})?"
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>

          <div className="field" style={{ flex: '1 1 150px' }}>
            <label className="label" htmlFor="expense-date">
              Spent on
            </label>
            <input
              id="expense-date"
              className="input"
              type="date"
              required
              max={new Date().toISOString().slice(0, 10)}
              value={spentOn}
              onChange={(e) => setSpentOn(e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label className="label" htmlFor="expense-description">
            What was this for
          </label>
          <input
            id="expense-description"
            className="input"
            required
            minLength={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {needsReceipt ? (
          <div className="field">
            <label className="label" htmlFor="expense-receipt">
              Receipt reference
            </label>
            <input
              id="expense-receipt"
              className="input"
              required
              value={receiptKey}
              placeholder="receipts/2026-08-cab.pdf"
              onChange={(e) => setReceiptKey(e.target.value)}
              aria-describedby="receipt-hint"
            />
            <span className="field-hint" id="receipt-hint">
              {category?.name} claims above {category?.receiptRequiredAbove} need one. File upload
              arrives with the Documents module; this stores the key.
            </span>
          </div>
        ) : null}

        <button
          className="btn btn-primary"
          type="submit"
          style={{ alignSelf: 'flex-start' }}
          disabled={pending || !amount || !spentOn || !description}
        >
          {pending ? 'Saving…' : 'Save draft'}
        </button>
      </form>
    </section>
  );
}
