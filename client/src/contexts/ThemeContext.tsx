import React, { createContext, useContext, useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark' | 'warm';
export type ResolvedThemeMode = 'light' | 'dark';

interface ThemeContextValue {
  themePreference: ThemePreference;
  resolvedMode: ResolvedThemeMode;
  setThemePreference: (pref: ThemePreference) => void;
  toggleLightDark: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  themePreference: 'system',
  resolvedMode: 'light',
  setThemePreference: () => {},
  toggleLightDark: () => {}
});

function getSystemDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function loadSavedPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  try {
    const saved = localStorage.getItem('bionic_theme');
    if (saved === 'system' || saved === 'light' || saved === 'dark' || saved === 'warm') {
      return saved;
    }
  } catch {}
  return 'system';
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(loadSavedPreference);
  const [systemIsDark, setSystemIsDark] = useState<boolean>(getSystemDark);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemIsDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const resolvedMode: ResolvedThemeMode =
    themePreference === 'dark' || (themePreference === 'system' && systemIsDark)
      ? 'dark'
      : 'light';

  const appliedThemeAttr =
    themePreference === 'warm' ? 'warm' : resolvedMode;

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = appliedThemeAttr;
    if (resolvedMode === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [appliedThemeAttr, resolvedMode]);

  const setThemePreference = (pref: ThemePreference) => {
    setThemePreferenceState(pref);
    try {
      localStorage.setItem('bionic_theme', pref);
    } catch {}
  };

  const toggleLightDark = () => {
    setThemePreference(resolvedMode === 'dark' ? 'light' : 'dark');
  };

  return (
    <ThemeContext.Provider
      value={{
        themePreference,
        resolvedMode,
        setThemePreference,
        toggleLightDark
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
};

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
