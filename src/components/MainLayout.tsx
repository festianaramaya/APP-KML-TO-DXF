import React, { useEffect } from "react";
import "../assets/MainLayout.css";

interface MainLayoutProps {
  children: React.ReactNode;
  pageTitle: string;
}

export default function MainLayout({ children, pageTitle }: MainLayoutProps) {
  useEffect(() => {
    if (pageTitle) {
      document.title = `${pageTitle} - VALORA`;
    }
  }, [pageTitle]);

  return (
    <div className="layout-wrapper">
      {/* HEADER GAMBAR ASLI VALORA */}
      <header className="layout-header-img-banner"></header>

      {/* BODY FULL WIDTH */}
      <div className="layout-body">
        <img 
          src="/images/peta.png" 
          alt="Peta Indonesia" 
          className="body-bg-map-img" 
        />

        <main className="layout-content-full">
          <div className="feature-page-header-banner">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
            </svg>
            <span>{pageTitle}</span>
          </div>
          <div className="feature-page-content">{children}</div>
        </main>
      </div>

      {/* FOOTER TEKS HITAM STABIL */}
      <footer className="layout-footer-dark">
        <div>
          © 2026 Telkom Akses | Infrastructure Management Tool | Developed by <span className="footer-red-text">SDI & KERJA PRAKTEK PENS</span>
        </div>
      </footer>
    </div>
  );
}