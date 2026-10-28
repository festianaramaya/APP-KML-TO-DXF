import React, { useState } from 'react';
import MainLayout from "../components/MainLayout";
import '../assets/KmlToDxf.css';

const API_BASE = 'http://localhost:5000';

type ConversionType = 'dxf' | 'csv';

export default function KmlToDxf() {
  const [files, setFiles] = useState<Record<ConversionType, File | null>>({ dxf: null, csv: null });
  const [status, setStatus] = useState<Record<ConversionType, { type: 'success' | 'error' | 'loading' | '', message: string }>>({
    dxf: { type: '', message: '' },
    csv: { type: '', message: '' }
  });

  const [totalFeatures, setTotalFeatures] = useState<number>(0);
  const [mode, setMode] = useState<'route' | 'route_homepass'>('route_homepass');
  const [mitra, setMitra] = useState<'mitraA' | 'mitraB' | 'mitraC'>('mitraC');

  const handleFileChange = (type: ConversionType, file: File) => {
    if (!file.name.toLowerCase().endsWith('.kml')) {
      setStatus(prev => ({ ...prev, [type]: { type: 'error', message: '✕ Hanya file KML' } }));
      return;
    }

    setFiles(prev => ({ ...prev, [type]: file }));
    setStatus(prev => ({ ...prev, [type]: { type: '', message: 'File siap dikonversi' } }));

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(text, "text/xml");
        const placemarks = xmlDoc.getElementsByTagName("Placemark");
        setTotalFeatures(placemarks.length);
      } catch (err) {
        console.error("Gagal membaca KML:", err);
      }
    };

    reader.readAsText(file);
  };

  const handleConvert = async (type: ConversionType) => {
    const file = files[type];
    if (!file) return;

    setStatus(prev => ({ ...prev, [type]: { type: 'loading', message: 'MENGONVERSI...' } }));
    const formData = new FormData();
    formData.append('file', file);
    formData.append('mode', mode);
    formData.append('tipeMitra', mitra);

    try {
      const response = await fetch(`${API_BASE}/api/upload_kml`, { method: 'POST', body: formData });
      if (!response.ok) throw new Error();

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `KML_to_DXF_${file.name.replace(/\.kml$/i, '.dxf')}`;
      document.body.appendChild(a);
      a.click();
      a.remove();

      setStatus(prev => ({ ...prev, [type]: { type: 'success', message: 'Sukses diunduh!' } }));
    } catch {
      setStatus(prev => ({ ...prev, [type]: { type: 'error', message: 'Gagal mengonversi file' } }));
    }
  };

  return (
    <MainLayout pageTitle="KML to DXF" activeMenu="kml-to-dxf">
      <div className="dxf-wrapper">
        <div className="dxf-inner-container">
          
          {/* UPLOAD FILE SECTION */}
          <div>
            <div className="dxf-form-label">
              <span>File KML</span>
              <span className="required">*</span>
              {totalFeatures > 0 && <span style={{ color: '#64748b', fontWeight: 500 }}>({totalFeatures} fitur terdeteksi)</span>}
            </div>

            <div
              className={`upload-zone-dxf ${files.dxf ? 'has-file' : ''}`}
              onClick={() => document.getElementById('file-dxf')?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) handleFileChange('dxf', f);
              }}
            >
              <input
                type="file"
                id="file-dxf"
                accept=".kml"
                style={{ display: 'none' }}
                onChange={(e) => e.target.files?.[0] && handleFileChange('dxf', e.target.files[0])}
              />

              <div className="dxf-upload-icon">
                <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="17 8 12 3 7 8"></polyline>
                  <line x1="12" y1="3" x2="12" y2="15"></line>
                </svg>
              </div>

              <div className="dxf-upload-title">
                {files.dxf ? files.dxf.name : 'Klik untuk memilih file atau drag & drop di sini'}
              </div>
              <div className="dxf-upload-subtitle">
                {files.dxf ? 'Siap diproses' : 'Belum ada file dipilih'}
              </div>
            </div>
          </div>

          {/* DROPDOWN PILIH MITRA */}
          <div>
            <div className="dxf-form-label">
              <span>Pilih Pekerjaan (Mitra)</span>
              <span className="required">*</span>
            </div>
            <select
              className="dxf-mitra-select"
              value={mitra}
              onChange={(e) => setMitra(e.target.value as 'mitraC' | 'mitraA' | 'mitraB')}
            >
              <option value="mitraC">Telkom</option>
              <option value="mitraA">MyRepublic</option>
              <option value="mitraB">Internet Rakyat</option>
            </select>
          </div>

          {/* RADIO BUTTON GENERATION OPTIONS */}
          <div className="dxf-options-container">
            <div className="dxf-form-label">
              <span>Generation Options</span>
              <span className="required">*</span>
            </div>

            <div className="dxf-options-group">
              <label className={`dxf-radio-card ${mode === 'route' ? 'active' : ''}`}>
                <input
                  type="radio"
                  name="generateMode"
                  value="route"
                  checked={mode === 'route'}
                  onChange={() => setMode('route')}
                />
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3v18h18" />
                  <path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3" />
                </svg>
                <span>Route Only (Tanpa Bangunan)</span>
              </label>

              <label className={`dxf-radio-card ${mode === 'route_homepass' ? 'active' : ''}`}>
                <input
                  type="radio"
                  name="generateMode"
                  value="route_homepass"
                  checked={mode === 'route_homepass'}
                  onChange={() => setMode('route_homepass')}
                />
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <line x1="9" y1="3" x2="9" y2="21" />
                  <line x1="15" y1="3" x2="15" y2="21" />
                  <line x1="3" y1="9" x2="21" y2="9" />
                  <line x1="3" y1="15" x2="21" y2="15" />
                </svg>
                <span>Route Include Homepass</span>
              </label>
            </div>
          </div>

          {/* SUBMIT BUTTON */}
          <button
            className="dxf-btn-convert"
            onClick={() => handleConvert('dxf')}
            disabled={!files.dxf || status.dxf.type === 'loading'}
          >
            {status.dxf.type === 'loading' ? 'Memproses...' : 'GENERATE'}
          </button>

          {/* ALERT MESSAGES */}
          {status.dxf.message && (
            <div className={`dxf-alert ${status.dxf.type}`}>
              {status.dxf.message}
            </div>
          )}
        </div>
      </div>
    </MainLayout>
  );
}