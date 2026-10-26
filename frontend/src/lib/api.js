export async function api(path, { token, body, method = 'GET' } = {}) {
  const multipart = body instanceof FormData;
  const response = await fetch(`/api${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(!multipart && body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request failed.');
  return data;
}
export function unwrap(response) { if (response.error) throw new Error(response.error.message); return response.data; }
export function age(value) {
  if (!value) return 'No observations yet';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return new Date(value).toLocaleString();
}
export const roleNames = { parking_administrator: 'Parking Administrator', security_personnel: 'Security Personnel', parking_personnel: 'Parking Personnel' };
