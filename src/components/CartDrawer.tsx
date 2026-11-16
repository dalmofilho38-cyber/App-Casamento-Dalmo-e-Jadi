import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Minus, Plus, Trash2, X } from 'lucide-react';
import { useWedding } from '../context/WeddingContext';
import { formatBRL } from '../lib/pix';
import { CartItem } from '../types/wedding';

const FLEXIBLE_PRESET_CENTS = [10000, 15000, 25000, 50000];

function isFlexibleCartItem(item: CartItem): boolean {
  return item.gift.category === 'Lua de mel' || item.gift.giftType === 'symbolic';
}

function getCartItemTotalCents(item: CartItem): number {
  return isFlexibleCartItem(item)
    ? (item.customAmountCents ?? item.gift.priceCents)
    : item.gift.priceCents * item.quotas;
}

const FlexibleAmountControl: React.FC<{
  giftId: string;
  amountCents: number;
  suggestedCents: number;
  onChangeAmount: (giftId: string, cents: number) => void;
}> = ({ giftId, amountCents, suggestedCents, onChangeAmount }) => {
  const [draft, setDraft] = useState(() => (amountCents / 100).toFixed(2).replace('.', ','));

  useEffect(() => {
    setDraft((amountCents / 100).toFixed(2).replace('.', ','));
  }, [amountCents]);

  const presets = Array.from(new Set([...FLEXIBLE_PRESET_CENTS, suggestedCents]))
    .filter((v) => v >= 100)
    .sort((a, b) => a - b);

  const handleDraftChange = (value: string) => {
    setDraft(value);
    const cleaned = value.replace(/[^\d,]/g, '').replace(',', '.');
    const num = Number.parseFloat(cleaned);
    if (!Number.isNaN(num) && num >= 1) {
      onChangeAmount(giftId, Math.round(num * 100));
    }
  };

  return (
    <div className="mt-2.5 space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {presets.map((cents) => {
          const active = amountCents === cents;
          return (
            <button
              key={cents}
              type="button"
              onClick={() => onChangeAmount(giftId, cents)}
              className={`rounded px-2 py-1 text-[11px] font-semibold tabular-nums transition-colors ${
                active
                  ? 'border border-terracota-escuro bg-terracota-escuro text-creme-claro'
                  : 'border border-dourado/45 bg-creme-claro text-marrom hover:bg-pergaminho'
              }`}
            >
              {formatBRL(cents)}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <label
          htmlFor={`cart-custom-${giftId}`}
          className="text-[11px] font-medium text-marrom-suave whitespace-nowrap"
        >
          Outro valor (R$):
        </label>
        <input
          id={`cart-custom-${giftId}`}
          type="text"
          inputMode="decimal"
          value={draft}
          onChange={(e) => handleDraftChange(e.target.value)}
          className="w-28 rounded border border-dourado/45 bg-creme-claro px-2.5 py-1 text-xs font-semibold text-terracota-escuro tabular-nums focus:border-terracota-escuro focus:outline-none"
        />
      </div>
    </div>
  );
};

export const CartDrawer: React.FC = () => {
  const {
    cart,
    cartOpen,
    setCartOpen,
    updateCartQuotas,
    updateCartCustomAmount,
    removeFromCart,
  } = useWedding();
  const navigate = useNavigate();

  if (!cartOpen) return null;

  const totalCents = cart.reduce((acc, item) => acc + getCartItemTotalCents(item), 0);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-marrom/45 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label="Sacola de presentes"
    >
      <div className="flex h-full w-full max-w-md flex-col bg-creme-claro shadow-2xl border-l border-dourado/40">
        <div className="flex items-center justify-between border-b border-dourado/25 px-6 py-5">
          <div>
            <h2 className="font-display text-2xl font-semibold text-marrom">
              Presentes Selecionados
            </h2>
            <p className="text-xs text-marrom-suave mt-0.5">
              Revise suas escolhas antes de gerar o Pix
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCartOpen(false)}
            aria-label="Fechar sacola"
            className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-dourado/30 text-marrom hover:bg-pergaminho transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {cart.length === 0 ? (
            <div className="py-16 text-center">
              <p className="font-display text-xl text-marrom">Sua sacola está vazia</p>
              <p className="mt-2 text-sm text-marrom-suave">
                Escolha um presente na lista ou contribua com o valor que desejar via Pix.
              </p>
              <button
                type="button"
                onClick={() => {
                  setCartOpen(false);
                  navigate('/pix?custom=1');
                }}
                className="mt-6 inline-flex items-center justify-center rounded-md border border-terracota-escuro px-4 py-2 text-sm font-medium text-terracota-escuro hover:bg-terracota/10 transition-colors"
              >
                Fazer contribuição livre
              </button>
            </div>
          ) : (
            cart.map((item) => {
              const remaining = Math.max(
                1,
                item.gift.totalQuotas - item.gift.reservedQuotas - item.gift.paidQuotas
              );
              const isFlexible = isFlexibleCartItem(item);
              const lineCents = getCartItemTotalCents(item);

              return (
                <div
                  key={item.gift.id}
                  className="flex gap-4 rounded-lg border border-dourado/30 bg-creme/55 p-4"
                >
                  {item.gift.imageUrl && (
                    <img
                      src={item.gift.imageUrl}
                      alt={item.gift.title}
                      referrerPolicy="no-referrer"
                      className="h-20 w-20 shrink-0 rounded-md object-cover border border-dourado/20"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-marrom-suave">
                      {item.gift.category === 'Lua de mel' ? 'Lua de Mel' : item.gift.category}
                    </p>
                    <h3 className="font-display text-base font-semibold text-marrom truncate">
                      {item.gift.title}
                    </h3>
                    <p className="mt-1 text-sm font-semibold text-terracota-escuro tabular-nums">
                      {formatBRL(lineCents)}
                      <span className="ml-1.5 text-xs font-normal text-marrom-suave">
                        {isFlexible
                          ? '· Contribuição'
                          : `(${item.quotas} ${item.quotas === 1 ? 'unidade' : 'unidades'} · ${formatBRL(item.gift.priceCents)} cada)`}
                      </span>
                    </p>

                    {isFlexible ? (
                      <div className="mt-1">
                        <FlexibleAmountControl
                          giftId={item.gift.id}
                          amountCents={lineCents}
                          suggestedCents={item.gift.priceCents}
                          onChangeAmount={updateCartCustomAmount}
                        />
                        <div className="mt-2.5 flex justify-end">
                          <button
                            type="button"
                            onClick={() => removeFromCart(item.gift.id)}
                            aria-label={`Remover ${item.gift.title}`}
                            className="inline-flex items-center gap-1 text-xs text-marrom-suave hover:text-terracota-escuro transition-colors"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Remover
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3 flex items-center justify-between">
                        <div className="inline-flex items-center rounded-md border border-dourado/40 bg-creme-claro">
                          <button
                            type="button"
                            onClick={() => updateCartQuotas(item.gift.id, item.quotas - 1)}
                            aria-label="Diminuir quantidade"
                            className="p-1.5 text-marrom hover:bg-pergaminho transition-colors"
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </button>
                          <span className="px-3 text-xs font-semibold tabular-nums">
                            {item.quotas}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              updateCartQuotas(item.gift.id, Math.min(remaining, item.quotas + 1))
                            }
                            aria-label="Aumentar quantidade"
                            className="p-1.5 text-marrom hover:bg-pergaminho transition-colors"
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                        </div>

                        <button
                          type="button"
                          onClick={() => removeFromCart(item.gift.id)}
                          aria-label={`Remover ${item.gift.title}`}
                          className="inline-flex items-center gap-1 text-xs text-marrom-suave hover:text-terracota-escuro transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Remover
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {cart.length > 0 && (
          <div className="border-t border-dourado/30 bg-pergaminho/50 px-6 py-5">
            <div className="flex items-center justify-between text-base font-semibold text-marrom">
              <span>Total selecionado</span>
              <span className="text-xl text-terracota-escuro tabular-nums">
                {formatBRL(totalCents)}
              </span>
            </div>
            <p className="mt-1 text-xs text-marrom-suave">
              A reserva protege contra duplicidade enquanto você conclui o Pix.
            </p>
            <button
              type="button"
              onClick={() => {
                setCartOpen(false);
                navigate('/pix');
              }}
              className="mt-4 w-full rounded-md bg-terracota-escuro px-5 py-3 text-sm font-semibold tracking-wide text-creme-claro uppercase hover:bg-terracota transition-colors"
            >
              Continuar para o Pix
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
