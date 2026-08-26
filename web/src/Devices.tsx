import { useCallback, useEffect, useState } from 'react';
import {
  listDevices,
  mintDevice,
  revokeDevice,
  type Connection,
  type Device,
  type MintedDevice,
} from './api';

/**
 * Devices holding a token, and the controls to add and remove them.
 *
 * The point of the screen is that revoking is cheap enough to actually do. A
 * response to a lost phone that costs an evening of re-pairing everything else
 * gets deferred, and a deferred revocation is the same as none.
 */

interface Props {
  connection: Connection;
  onClose: () => void;
  /** Called when the token this client uses has been revoked. */
  onSelfRevoked: () => void;
}

function ago(seconds: number): string {
  if (!seconds) return 'never used';
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

export function Devices({ connection, onClose, onSelfRevoked }: Props) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [name, setName] = useState('');
  const [minted, setMinted] = useState<MintedDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setDevices(await listDevices(connection));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [connection]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      setMinted(await mintDevice(connection, trimmed));
      setName('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (device: Device) => {
    // Revoking your own token is a legitimate thing to do — it is what you do
    // from a device you are handing on — but it ends this session, so it gets
    // a different warning rather than the same one.
    const message = device.current
      ? `Revoke "${device.name}"?\n\nThat is the token this browser is using, so you will be signed out here immediately.`
      : `Revoke "${device.name}"?\n\nAnything using it loses access at once, including any terminal it has open.`;
    if (!window.confirm(message)) return;

    setBusy(true);
    setError(null);
    try {
      const response = await revokeDevice(connection, device.id);
      if (!response.ok && response.status !== 404) {
        throw new Error(`revoke failed with ${response.status}`);
      }
      if (device.current) {
        onSelfRevoked();
        return;
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.pair_url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Refused clipboard access. The URL is on screen to be copied by hand.
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-header">
          <h2>Devices</h2>
          <button type="button" className="link" onClick={onClose}>
            Done
          </button>
        </header>

        {error && <div className="banner error">{error}</div>}

        {minted ? (
          <div className="minted">
            <p className="minted-lede">
              Scan this on <strong>{minted.name}</strong>. It opens already connected.
            </p>

            {/*
              A data URI rather than dangerouslySetInnerHTML. The markup comes
              from our own daemon, but an <img> cannot execute anything, and
              there is no reason to take the wider option for a picture.
            */}
            {minted.qr_svg && (
              <img
                className="minted-qr"
                alt={`Pairing code for ${minted.name}`}
                src={`data:image/svg+xml;utf8,${encodeURIComponent(minted.qr_svg)}`}
              />
            )}

            <p className="minted-note">
              This is the only time it is shown — the daemon keeps only a hash.
            </p>

            <div className="minted-actions">
              <button type="button" className="primary" onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy link'}
              </button>
              <button type="button" className="link" onClick={() => setMinted(null)}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <ul className="device-list">
              {devices?.map((device) => (
                <li key={device.id} className={device.current ? 'current' : ''}>
                  <div className="device-row">
                    <span className="device-name">
                      {device.name}
                      {device.current && <span className="device-tag">this device</span>}
                    </span>
                    <span className="device-meta">
                      {ago(device.last_seen)}
                      {device.last_ip ? ` · ${device.last_ip}` : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Revoke ${device.name}`}
                    disabled={busy}
                    onClick={() => void remove(device)}
                  >
                    ✕
                  </button>
                </li>
              ))}
              {devices?.length === 0 && (
                <li className="empty">
                  No stored devices. This daemon is running on a token from its
                  environment, which cannot be revoked from here.
                </li>
              )}
              {devices === null && <li className="empty">Loading…</li>}
            </ul>

            <form className="new-session" onSubmit={add}>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="New device name"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <button type="submit" className="primary" disabled={busy || !name.trim()}>
                Add
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
