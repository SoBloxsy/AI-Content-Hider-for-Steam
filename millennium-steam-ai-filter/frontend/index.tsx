import {
  ButtonItem,
  Dropdown,
  Field,
  PanelSection,
  PanelSectionRow,
  ToggleField,
  definePlugin,
  subscribePluginConfig,
} from 'millennium';
import { useEffect, useState } from 'react';

interface FilterSettingsSnapshot {
  filterMode: 'text' | 'highlight' | 'hide';
  ignoreLocalization: boolean;
  ignoreCode: boolean;
  ignoreConceptArt: boolean;
  ignoreMarketing: boolean;
  ignoreEarlyAccess: boolean;
  ignorePreRelease: boolean;
  cacheRevision: number;
}

interface StatsSnapshot {
  totalChecked: number;
  totalFlagged: number;
}

type FlagKey =
  | 'ignoreLocalization'
  | 'ignoreCode'
  | 'ignoreConceptArt'
  | 'ignoreMarketing'
  | 'ignoreEarlyAccess'
  | 'ignorePreRelease';

const MODE_OPTIONS = [
  { data: 'text', label: 'Text Only — Compact disclosure tag' },
  { data: 'highlight', label: 'Highlight — Colored outline & thumbnail tint' },
  { data: 'hide', label: 'Hide Games — Remove matching items' },
];

const EXCEPTION_FIELDS: Array<{ key: FlagKey; label: string; description: string }> = [
  {
    key: 'ignoreLocalization',
    label: 'Ignore Translations',
    description: 'Allow AI-assisted subtitles, localization, and multilingual translation.',
  },
  {
    key: 'ignoreCode',
    label: 'Ignore Code & Dev Tools',
    description: 'Allow AI coding assistants, scripting helpers, or Copilot usage.',
  },
  {
    key: 'ignoreConceptArt',
    label: 'Ignore Concept Art',
    description: 'Allow early ideation or prototyping art replaced before final release.',
  },
  {
    key: 'ignoreMarketing',
    label: 'Ignore Marketing & Store Assets',
    description: 'Allow AI-assisted store page banners, trailers, or capsule art.',
  },
  {
    key: 'ignoreEarlyAccess',
    label: 'Ignore Early Access',
    description: 'Skip AI flags and filters on Early Access titles.',
  },
  {
    key: 'ignorePreRelease',
    label: 'Ignore Pre-Release',
    description: 'Skip AI flags and filters on Coming Soon or Pre-Purchase titles.',
  },
];

const DEFAULT_SETTINGS: FilterSettingsSnapshot = {
  filterMode: 'text',
  ignoreLocalization: false,
  ignoreCode: false,
  ignoreConceptArt: false,
  ignoreMarketing: false,
  ignoreEarlyAccess: false,
  ignorePreRelease: false,
  cacheRevision: 1,
};

const PluginIcon = () => {
  const [svgMarkup, setSvgMarkup] = useState<string>('');

  useEffect(() => {
    backend
      .getWarningIconSvg()
      .then((svg: string) => setSvgMarkup(svg || ''))
      .catch(() => {});
  }, []);

  if (!svgMarkup) {
    return (
      <span
        style={{
          display: 'inline-block',
          width: '16px',
          height: '16px',
          marginRight: '6px',
          borderRadius: '3px',
          backgroundColor: '#d32f2f',
        }}
      />
    );
  }

  return (
    <img
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup)}`}
      alt="AI Filter"
      style={{
        width: '16px',
        height: '16px',
        marginRight: '6px',
        verticalAlign: 'middle',
      }}
    />
  );
};

const SettingsContent = () => {
  const [settings, setSettings] = useState<FilterSettingsSnapshot>(DEFAULT_SETTINGS);
  const [stats, setStats] = useState<StatsSnapshot>({ totalChecked: 0, totalFlagged: 0 });
  const [cacheNotice, setCacheNotice] = useState<string>('Clear Disclosure Cache');

  const refreshFromBackend = () => {
    backend
      .getSettings()
      .then((res: unknown) => {
        if (res && typeof res === 'object') {
          setSettings(res as FilterSettingsSnapshot);
        }
      })
      .catch(() => {});
    backend
      .getStats()
      .then((res: unknown) => {
        if (res && typeof res === 'object') {
          setStats(res as StatsSnapshot);
        }
      })
      .catch(() => {});
  };

  useEffect(() => {
    refreshFromBackend();
    const unsubscribe = subscribePluginConfig(() => {
      refreshFromBackend();
    });
    return () => unsubscribe();
  }, []);

  const handleModeChange = (option: { data: string }) => {
    const nextMode = option.data as FilterSettingsSnapshot['filterMode'];
    backend
      .setFilterMode(nextMode)
      .then((res: unknown) => {
        if (res && typeof res === 'object') setSettings(res as FilterSettingsSnapshot);
      })
      .catch(() => {});
  };

  const handleFlagChange = (key: FlagKey, value: boolean) => {
    backend
      .setFilterFlag(key, value)
      .then((res: unknown) => {
        if (res && typeof res === 'object') setSettings(res as FilterSettingsSnapshot);
      })
      .catch(() => {});
  };

  const handleClearCache = () => {
    backend
      .bumpCacheRevision()
      .then((nextRev: number) => {
        setSettings((prev) => ({ ...prev, cacheRevision: nextRev }));
        setCacheNotice('Cache Purged!');
        setTimeout(() => setCacheNotice('Clear Disclosure Cache'), 1500);
      })
      .catch(() => {});
  };

  const handleResetStats = () => {
    backend
      .resetStats()
      .then((res: unknown) => {
        if (res && typeof res === 'object') setStats(res as StatsSnapshot);
      })
      .catch(() => {});
  };

  return (
    <>
      <PanelSection title="Filter Mode">
        <PanelSectionRow>
          <Field
            label="Display Mode"
            description="Hide mode automatically falls back to Highlight on your personal Wishlist."
          >
            <Dropdown
              rgOptions={MODE_OPTIONS}
              selectedOption={settings.filterMode}
              onChange={handleModeChange}
            />
          </Field>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Category Exceptions">
        {EXCEPTION_FIELDS.map((field) => (
          <PanelSectionRow key={field.key}>
            <ToggleField
              label={field.label}
              description={field.description}
              checked={settings[field.key]}
              onChange={(checked: boolean) => handleFlagChange(field.key, checked)}
            />
          </PanelSectionRow>
        ))}
      </PanelSection>

      <PanelSection title="Statistics & Cache">
        <PanelSectionRow>
          <Field label="Games Checked" description="Total store items inspected across Steam Store views.">
            <span>{stats.totalChecked.toLocaleString()}</span>
          </Field>
        </PanelSectionRow>
        <PanelSectionRow>
          <Field label="AI Disclosures Flagged" description="Games matching active AI disclosure rules.">
            <span>{stats.totalFlagged.toLocaleString()}</span>
          </Field>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={handleClearCache}>
            {cacheNotice}
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={handleResetStats}>
            Reset Statistics
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
};

export default definePlugin(() => {
  return {
    title: 'AI Disclosure Filter',
    icon: <PluginIcon />,
    content: <SettingsContent />,
  };
});
