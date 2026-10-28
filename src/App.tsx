import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import KmlToDxf from './pages/KmlToDxf';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<KmlToDxf />} />
        <Route path="/kml-to-dxf" element={<KmlToDxf />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}