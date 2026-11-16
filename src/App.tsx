import React, { useEffect, useState } from 'react';
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom';
import { X } from 'lucide-react';
import { WeddingProvider, useWedding } from './context/WeddingContext';
import { Navbar } from './components/Navbar';
import { Footer } from './components/Footer';
import { CartDrawer } from './components/CartDrawer';
import { FloatingGiftButton } from './components/FloatingGiftButton';
import { FallingPetalsBackground } from './components/FallingPetalsBackground';
import { PrivacyModal } from './components/PrivacyModal';
import { HomePage } from './pages/HomePage';
import { StoryPage } from './pages/StoryPage';
import { GiftsPage } from './pages/GiftsPage';
import { PixCheckoutPage } from './pages/PixCheckoutPage';
import { ThankYouPage } from './pages/ThankYouPage';
import { RsvpPage } from './pages/RsvpPage';
import { GuestbookPage } from './pages/GuestbookPage';
import { GalleryPage } from './pages/GalleryPage';
import { CeremonyPage } from './pages/CeremonyPage';
import { FaqPage } from './pages/FaqPage';
import { AdminPage } from './pages/AdminPage';

const ScrollToTop: React.FC = () => {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
};

const DemoBanner: React.FC = () => {
  const { isDemoMode } = useWedding();
  const [dismissed, setDismissed] = useState(false);

  if (!isDemoMode || dismissed) return null;

  return (
    <div className="relative z-30 border-b border-dourado/30 bg-creme/90 px-4 py-2 text-xs text-marrom backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
        <p>
          <strong>Modo Demonstração:</strong> dados ilustrativos ativos sem necessidade de
          credenciais Pix ou servidor neste momento. Nenhum pagamento real é simulado.{' '}
          <Link to="/admin" className="font-semibold text-terracota-escuro underline">
            Abrir Painel
          </Link>
        </p>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Ocultar aviso de modo demonstração"
          className="p-1 text-marrom-suave hover:text-marrom shrink-0"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};

export default function App() {
  return (
    <WeddingProvider>
      <BrowserRouter>
        <ScrollToTop />
          <div className="watercolor-paper relative flex min-h-screen flex-col text-marrom">
            <FallingPetalsBackground />
            <Navbar />
            <DemoBanner />
            <main className="relative flex-1">
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/historia" element={<StoryPage />} />
                <Route path="/presentes" element={<GiftsPage />} />
                <Route path="/pix" element={<PixCheckoutPage />} />
                <Route path="/obrigado" element={<ThankYouPage />} />
                <Route path="/rsvp" element={<RsvpPage />} />
                <Route path="/recados" element={<GuestbookPage />} />
                <Route path="/galeria" element={<GalleryPage />} />
                <Route path="/cerimonia" element={<CeremonyPage />} />
                <Route path="/faq" element={<FaqPage />} />
                <Route path="/admin" element={<AdminPage />} />
                <Route path="*" element={<HomePage />} />
              </Routes>
            </main>
            <Footer />
            <FloatingGiftButton />
            <CartDrawer />
            <PrivacyModal />
          </div>
      </BrowserRouter>
    </WeddingProvider>
  );
}
