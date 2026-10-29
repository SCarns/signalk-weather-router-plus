// Optional handoff of a generated polar. Polar Management owns validation,
// naming and storage; this never changes its active selection or shared factor.
const IMPORT_URL = '/plugins/signalk-polar-management/imports/text/canonical';

/**
 * Save a new copy through Polar Management's canonical importer. No id or
 * overwrite option is supplied; existing polars are left to the provider.
 * @param {(url: string, init?: object) => Promise<Response>} fetchFn authenticated same-server fetch
 * @param {object} canonical canonical polarTable document from the generator
 * @returns {Promise<string>} the provider's new resource id
 */
export async function saveGeneratedPolar(fetchFn, canonical) {
  const response = await fetchFn(IMPORT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: JSON.stringify(canonical) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 404 || response.status === 405 || response.status === 503) {
      throw new Error('Polar Management is unavailable or does not support canonical imports. Enable or update it, then try again. Your local polar is saved.');
    }
    throw new Error(data && data.error ? String(data.error) : 'Polar Management could not save the copy (HTTP ' + response.status + '). Your local polar is saved.');
  }
  if (!data || typeof data.id !== 'string' || !data.id) {
    throw new Error('Polar Management did not return the saved polar id. Check its library before trying again.');
  }
  return data.id;
}

/**
 * Offer an explicit save after local generation succeeds. A failed provider
 * request leaves the local table and route selection available for use.
 * @param {HTMLElement} container the generator's result area
 * @param {object} canonical generated canonical polarTable document
 * @param {(url: string, init?: object) => Promise<Response>} fetchFn authenticated same-server fetch
 */
export function offerPolarManagementSave(container, canonical, fetchFn) {
  const doc = container.ownerDocument;
  const row = doc.createElement('div');
  row.style.marginTop = '12px';
  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = 'Save a copy to Polar Management';
  const note = doc.createElement('div');
  note.style.marginTop = '4px';
  note.setAttribute('role', 'status');
  note.textContent = 'Adds a new polar to its library. Select it in Polar Management when you want to use it there.';
  const link = doc.createElement('a');
  link.href = '/signalk-polar-management/';
  link.textContent = 'Open Polar Management';
  link.style.display = 'block';
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      const id = await saveGeneratedPolar(fetchFn, canonical);
      button.textContent = 'Saved to Polar Management';
      note.textContent = 'Saved as ' + id + '. Select it in Polar Management when ready. The active polar has not changed.';
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Save a copy to Polar Management';
      note.textContent = error.message;
    }
  });
  row.append(button, note, link);
  container.appendChild(row);
}
