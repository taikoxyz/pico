import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout.js';
import { Dashboard } from './pages/Dashboard.js';
import { Dvm } from './pages/Dvm.js';
import { OpenChannel } from './pages/OpenChannel.js';
import { Pay } from './pages/Pay.js';
import { Settings } from './pages/Settings.js';

export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="open" element={<OpenChannel />} />
          <Route path="pay" element={<Pay />} />
          <Route path="dvm" element={<Dvm />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
