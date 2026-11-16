import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Clock, Heart } from 'lucide-react';
import { WatercolorCorners } from '../components/WatercolorCorners';
import { useWedding } from '../context/WeddingContext';

export const ThankYouPage: React.FC = () => {
  const { settings } = useWedding();
  const [searchParams] = useSearchParams();
  const pedido = searchParams.get('pedido');
  const status = searchParams.get('status') || 'awaiting_confirmation';
  const isConfirmed = status === 'confirmed';

  return (
    <div className="relative overflow-hidden py-16 sm:py-24">
      <WatercolorCorners variant="section" />
      <div className="relative z-20 mx-auto max-w-2xl px-4 sm:px-6">
        <div className="ornamental-frame rounded-xl bg-marfim/95 p-8 sm:p-12 text-center shadow-sm backdrop-blur-[2px]">
          {isConfirmed ? (
            <CheckCircle2 className="mx-auto h-12 w-12 text-oliva" />
          ) : (
            <Clock className="mx-auto h-12 w-12 text-terracota-escuro" />
          )}

          <p className="mt-4 text-xs font-semibold tracking-[0.2em] text-oliva uppercase">
            {isConfirmed ? 'Pagamento Confirmado' : 'Aguardando Confirmação'}
          </p>

          <h1 className="mt-2 font-display text-4xl sm:text-5xl font-semibold text-marrom">
            {isConfirmed
              ? 'Muito obrigado pelo seu presente!'
              : 'Obrigado pelo seu gesto de carinho!'}
          </h1>

          {pedido && (
            <p className="mt-2 text-xs font-mono text-marrom-suave">
              Referência do pedido: {pedido}
            </p>
          )}

          <div className="mx-auto my-5 h-px w-24 bg-dourado/40" aria-hidden="true" />

          {isConfirmed ? (
            <p className="text-base leading-relaxed text-marrom-suave">
              Seu presente foi confirmado com sucesso. {settings.coupleNames} agradecem de coração
              por fazerem parte desta nova etapa abençoada por Deus.
            </p>
          ) : (
            <p className="text-base leading-relaxed text-marrom-suave">
              Sua reserva foi registrada com o status <strong>Aguardando confirmação</strong>. Assim
              que a transferência Pix for confirmada pelos noivos ou pelo provedor integrado, o
              presente será marcado como confirmado no painel do casal.
            </p>
          )}

          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              to="/presentes"
              className="w-full sm:w-auto rounded-md bg-terracota-escuro px-6 py-3 text-xs font-semibold tracking-wider text-creme-claro uppercase hover:bg-terracota transition-colors"
            >
              Voltar aos presentes
            </Link>
            <Link
              to="/recados"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-md border border-terracota-escuro px-6 py-3 text-xs font-semibold tracking-wider text-terracota-escuro uppercase hover:bg-pergaminho transition-colors"
            >
              <Heart className="h-4 w-4" />
              Deixar recado no mural
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};
