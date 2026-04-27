import { cn } from '@/lib/cn.js';
import { Link, Outlet } from 'react-router-dom';

const NAV: { to: string; label: string }[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/open', label: 'Open' },
  { to: '/pay', label: 'Pay' },
  { to: '/dvm', label: 'DVM' },
  { to: '/settings', label: 'Settings' },
];

export function Layout(): JSX.Element {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-[hsl(var(--border))]">
        <nav className="max-w-5xl mx-auto flex items-center gap-6 p-4">
          <span className="font-semibold">tainnel</span>
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={cn('text-sm text-foreground/70 hover:text-foreground')}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="flex-1 max-w-5xl mx-auto w-full p-6">
        <Outlet />
      </main>
    </div>
  );
}
