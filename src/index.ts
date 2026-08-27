import joplin from 'api';
import { MenuItemLocation, SettingItemType } from 'api/types';

joplin.plugins.register({
	onStart: async () => {
		await joplin.settings.registerSection('webPublisherSection', {
			label: 'Web Publisher',
			iconName: 'fas fa-globe',
		});

		await joplin.settings.registerSettings({
			'serverUrl': {
				value: 'https://webnote.beerfactory.pt',
				type: SettingItemType.String,
				section: 'webPublisherSection',
				public: true,
				label: 'Web Server URL',
			},
			'userEmail': {
				value: '',
				type: SettingItemType.String,
				section: 'webPublisherSection',
				public: true,
				label: 'Account Email',
			},
			'userPassword': {
				value: '',
				type: SettingItemType.String,
				section: 'webPublisherSection',
				public: true,
				secure: true,
				label: 'Account Password',
			},
		});

		const dialogs = joplin.views.dialogs;
		const dialogHandle = await dialogs.create('publishDialog');

		let panelHandle: string | null = null;
		let isPanelVisible = false;

		const showMessage = async (htmlContent: string) => {
			await dialogs.setHtml(dialogHandle, `<div style="padding: 10px; line-height: 1.5; font-size: 13px;">${htmlContent}</div>`);
			await dialogs.setButtons(dialogHandle, [{ id: 'ok', title: 'OK' }]);
			await dialogs.open(dialogHandle);
		};

		const getAuthPayload = async () => {
			const email = await joplin.settings.value('userEmail');
			const password = await joplin.settings.value('userPassword');
			return { email: email ? email.trim() : '', password: password ? password.trim() : '' };
		};

		const fetchWithTimeout = async (url: string, options: any = {}, timeoutMs = 2500) => {
			const controller = new AbortController();
			const id = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const response = await fetch(url, { ...options, signal: controller.signal });
				clearTimeout(id);
				return response;
			} catch (err) {
				clearTimeout(id);
				throw err;
			}
		};

		// Titoli cartella, email utente e nomi gruppo finiscono in innerHTML dentro le webview del
		// pannello e della dialog di pubblicazione. Le webview di Joplin eseguono HTML/JS iniettato:
		// senza questo escape, una cartella con un titolo malevolo (anche solo condivisa da terzi)
		// potrebbe eseguire codice nel contesto del plugin.
		// L'emoji 👥 ha un colore diverso per ogni font di sistema (viola su Windows/Segoe UI Emoji,
		// grigio/nero altrove) — le emoji a colori ignorano il CSS `color`, quindi non è possibile
		// intonarla al resto dell'interfaccia. Un'icona SVG inline resta invece coerente ovunque.
		const GROUP_ICON_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6cb6ff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px; margin-right:2px;"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';

		const escapeHtml = (value: any): string => {
			if (value === null || value === undefined) return '';
			return String(value)
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')
				.replace(/'/g, '&#39;');
		};

		// ==========================================
		// GESTIONE SESSIONE ED AUTENTICAZIONE
		// ==========================================
		let cachedSession: { token: string; userId: string; expiresAt: number } | null = null;

		const getSessionToken = async (serverUrl: string, auth: { email: string; password: string }): Promise<{ token: string; userId: string } | null> => {
			const now = Date.now();
			if (cachedSession && cachedSession.expiresAt > now + 5000) {
				return { token: cachedSession.token, userId: cachedSession.userId };
			}
			try {
				const loginRes = await fetchWithTimeout(`${serverUrl}/api/login`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(auth),
				}, 5000);
				if (!loginRes.ok) return null;
				const loginData = await loginRes.json();
				if (!loginData.token || !loginData.userId) return null;
				cachedSession = {
					token: loginData.token,
					userId: loginData.userId,
					expiresAt: typeof loginData.expiresAt === 'number' ? loginData.expiresAt : now + 20 * 60 * 60 * 1000,
				};
				return { token: cachedSession.token, userId: cachedSession.userId };
			} catch (e) {
				return null;
			}
		};

		// ==========================================
		// WEB PUBLISHER CORE
		// ==========================================
		const getFolderPath = async (folderId: string): Promise<string> => {
			const parts: string[] = [];
			let currentId: string | null = folderId;
			while (currentId) {
				try {
					const folder = await joplin.data.get(['folders', currentId], { fields: ['id', 'title', 'parent_id'] });
					if (folder && folder.title) {
						parts.unshift(folder.title);
						currentId = folder.parent_id || null;
					} else {
						currentId = null;
					}
				} catch (e) {
					currentId = null;
				}
			}
			return parts.join('\\');
		};

		const getFolderTree = async (rootFolderId: string): Promise<any[]> => {
			let allJoplinFolders: any[] = [];
			let page = 1;
			let hasMore = true;
			while (hasMore) {
				const res = await joplin.data.get(['folders'], { fields: ['id', 'title', 'parent_id'], page: page++ });
				allJoplinFolders.push(...res.items);
				hasMore = res.has_more;
			}

			const result: any[] = [];
			const visited = new Set<string>();
			
			const collectDescendants = (id: string) => {
				if (visited.has(id)) return;
				visited.add(id);
				const folder = allJoplinFolders.find(f => f.id === id);
				if (folder) {
					result.push(folder);
					const children = allJoplinFolders.filter(f => f.parent_id === id);
					children.forEach(child => collectDescendants(child.id));
				}
			};

			collectDescendants(rootFolderId);
			return result;
		};

		const renderPanelContent = async () => {
			if (!panelHandle) return;
			const savedUrl = await joplin.settings.value('serverUrl');
			const serverUrl = savedUrl.trim().replace(/\/$/, '');
			const auth = await getAuthPayload();

			let publishedFolders: any[] = [];
			let groupsList: any[] = [];
			try {
				if (auth.email && auth.password) {
					const session = await getSessionToken(serverUrl, auth);
					if (session) {
						const authHeader = { 'Authorization': `Bearer ${session.token}` };

						const response = await fetchWithTimeout(`${serverUrl}/api/published-list`, { headers: authHeader }, 3000);
						const data = await response.json();
						publishedFolders = data.folders || [];

						// Serve solo per risolvere gli id gruppo in nomi leggibili qui sotto:
						// /api/published-list restituisce allowedGroups come id, non come nomi.
						if (publishedFolders.some(f => f.visibility === 'custom')) {
							const ugRes = await fetchWithTimeout(`${serverUrl}/api/users-and-groups`, { headers: authHeader }, 3000);
							const ugData = await ugRes.json();
							groupsList = ugData.groups || [];
						}
					}
				}
			} catch (err: any) {}

			let itemsHtml = '';
			if (publishedFolders.length === 0) {
				itemsHtml = `<div style="padding: 20px; text-align: center; font-size: 12px; opacity: 0.7;">ℹ️ No published notebooks found.</div>`;
			} else {
				for (const f of publishedFolders) {
					let visBadge = '🌍 Public';
					if (f.visibility === 'private') visBadge = '🔒 Registered';
					if (f.visibility === 'custom') visBadge = '🎯 Custom';

					let displayTitle = f.title;
					try {
						const localPath = await getFolderPath(f.id);
						if (localPath) displayTitle = localPath;
					} catch (e) {}

					let sharedWithHtml = '';
					if (f.visibility === 'custom') {
						const groupNames: string[] = (f.allowedGroups || []).map((gid: string) => {
							const g = groupsList.find(gr => gr.id === gid);
							return g ? GROUP_ICON_SVG + escapeHtml(g.name) : null;
						}).filter(Boolean);
						const userNames: string[] = (f.allowedUsers || []).map((email: string) => escapeHtml(email));
						const combined = [...groupNames, ...userNames];
						if (combined.length > 0) {
							sharedWithHtml = `<div style="font-size:11px; opacity:0.7; margin-bottom:10px; word-break:break-word;">Shared with: ${combined.join(', ')}</div>`;
						}
					}

					itemsHtml += `
						<div style="background: var(--joplin-background-color-2, #2a2e33); border: 1px solid var(--joplin-divider-color, #3a3f45); border-radius: 6px; padding: 10px; margin-bottom: 10px;">
							<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; font-size:13px;">
								<strong style="word-break: break-word;">📁 ${escapeHtml(displayTitle)}</strong>
								<span style="font-size:10px; background:#0e639c; color:white; padding:2px 5px; border-radius:3px; font-weight:bold; flex-shrink:0; margin-left:6px;">${visBadge}</span>
							</div>
							<div style="font-size:11px; opacity:0.7; margin-bottom:${sharedWithHtml ? '2px' : '10px'};">Web Notes: <b>${f.notesCount}</b></div>
							${sharedWithHtml}
							<div style="display:flex; gap:6px;">
								<button style="flex:1; padding:6px; background:#0e639c; color:white; border:none; border-radius:4px; font-weight:600; cursor:pointer; font-size:11px;" onclick="webviewApi.postMessage({ action: 'editPublish', folderId: '${f.id}' })">⚙️ Edit Access</button>
								<button style="flex:1; padding:6px; background:#a93226; color:white; border:none; border-radius:4px; font-weight:600; cursor:pointer; font-size:11px;" onclick="webviewApi.postMessage({ action: 'removePublish', folderId: '${f.id}' })">🗑️ Unpublish</button>
							</div>
						</div>
					`;
				}
			}

			const html = `
				<style>
					.panel-container { height: 100vh; display: flex; flex-direction: column; padding: 12px; box-sizing: border-box; color: var(--joplin-color); font-family: sans-serif; }
					.panel-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #3a3f45; padding-bottom: 8px; margin-bottom: 12px; flex-shrink: 0; }
					.panel-scroll-area { overflow-y: auto; flex-grow: 1; padding-right: 4px; }
					::-webkit-scrollbar { width: 6px; }
					::-webkit-scrollbar-track { background: transparent; }
					::-webkit-scrollbar-thumb { background: var(--joplin-divider-color, #555); border-radius: 3px; }
					::-webkit-scrollbar-thumb:hover { background: #777; }
				</style>
				<div class="panel-container">
					<div class="panel-header">
						<h3 style="margin:0; font-size:13px; text-transform:uppercase; letter-spacing:0.5px;">🌐 Web Publisher</h3>
						<button style="cursor:pointer; background:none; border:none; color:var(--joplin-color); font-size:14px;" onclick="webviewApi.postMessage({ action: 'refresh' })" title="Refresh list">🔄</button>
					</div>
					<div class="panel-scroll-area">${itemsHtml}</div>
				</div>
			`;
			await joplin.views.panels.setHtml(panelHandle, html);
		};

		const initPanelIfNeeded = async () => {
			if (!panelHandle) {
				panelHandle = await joplin.views.panels.create('webPublisherPanel');
				joplin.views.panels.onMessage(panelHandle, async (msg: any) => {
					const savedUrl = await joplin.settings.value('serverUrl');
					const serverUrl = savedUrl.trim().replace(/\/$/, '');
					const auth = await getAuthPayload();
					
					if (msg.action === 'editPublish') {
						await joplin.commands.execute('publishNotebookToWeb', msg.folderId);
					} else if (msg.action === 'removePublish') {
						const tree = await getFolderTree(msg.folderId);
						const foldersPayload = tree.map(f => ({ id: f.id, visibility: 'remove' }));
						const res = await fetchWithTimeout(`${serverUrl}/api/publish`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ auth, folders: foldersPayload }),
						}, 5000);
						if (!res.ok) {
							const errData = await res.json();
							// serverUrl è un'impostazione modificabile dall'utente: se puntasse a un server
							// malevolo/compromesso, un campo "error" non escapato diventerebbe XSS nella dialog.
							await showMessage(`❌ ${escapeHtml(errData.error || 'Authentication error')}`);
						}
						await renderPanelContent();
					} else if (msg.action === 'refresh') {
						await renderPanelContent();
					}
				});
			}
		};

		await joplin.commands.register({
			name: 'toggleWebPublisherPanel',
			label: '🌐 Toggle Web Publisher Panel',
			iconName: 'fas fa-globe',
			execute: async () => {
				await initPanelIfNeeded();
				isPanelVisible = !isPanelVisible;
				if (panelHandle) {
					await joplin.views.panels.show(panelHandle, isPanelVisible);
					if (isPanelVisible) await renderPanelContent();
				}
			},
		});

		await joplin.commands.register({
			name: 'publishNotebookToWeb',
			label: '🌐 Publish / Update / Remove from Web',
			iconName: 'fas fa-globe',
			execute: async (folderId?: string) => {
				let targetFolderId = folderId;
				if (!targetFolderId) {
					const selectedFolder = await joplin.workspace.selectedFolder();
					if (selectedFolder) targetFolderId = selectedFolder.id;
				}

				if (!targetFolderId) return await showMessage('⚠️ Please select a notebook first.');

				const auth = await getAuthPayload();
				if (!auth.email || !auth.password) {
					return await showMessage('⚠️ Credentials missing.<br><br>Please set your <b>Account Email</b> and <b>Password</b> in <i>Tools > Options > Web Publisher</i>.');
				}

				const savedUrl = await joplin.settings.value('serverUrl');
				const serverUrl = savedUrl.trim().replace(/\/$/, '');

				const targetFolders = await getFolderTree(targetFolderId);
				if (targetFolders.length === 0) return await showMessage('⚠️ Error reading folder data.');
				const rootFolder = targetFolders[0];
				const rootPath = await getFolderPath(rootFolder.id);

				let users: any[] = [];
				let groups: any[] = [];
				let publishedList: any[] = [];
				try {
					const session = await getSessionToken(serverUrl, auth);
					if (session) {
						const authHeader = { 'Authorization': `Bearer ${session.token}` };

						const ugRes = await fetchWithTimeout(`${serverUrl}/api/users-and-groups`, { headers: authHeader }, 4000);
						const ugData = await ugRes.json();
						users = ugData.users || [];
						groups = ugData.groups || [];

						const pubRes = await fetchWithTimeout(`${serverUrl}/api/published-list`, { headers: authHeader }, 4000);
						const pubData = await pubRes.json();
						publishedList = pubData.folders || [];
					}
				} catch (e) {}

				const currentPub = publishedList.find(p => p.id === targetFolderId);
				let currentVis = currentPub ? currentPub.visibility : 'public';
				let currentAllowedUsers: string[] = currentPub ? (currentPub.allowedUsers || []) : [];
				let currentAllowedGroups: string[] = currentPub ? (currentPub.allowedGroups || []) : [];

				while (true) {
					let usersCheckboxes = users.map((u, idx) => {
						const isChecked = currentAllowedUsers.includes(u.email) ? 'checked' : '';
						const safeEmail = escapeHtml(u.email);
						return `<label class="check-item"><input type="checkbox" name="user_${idx}" value="${safeEmail}" ${isChecked}><span title="${safeEmail}">${safeEmail}</span></label>`;
					}).join('');

					let groupsCheckboxes = groups.map((g, idx) => {
						const isChecked = currentAllowedGroups.includes(g.id) ? 'checked' : '';
						const safeName = escapeHtml(g.name);
						return `<label class="check-item"><input type="checkbox" name="group_${idx}" value="${escapeHtml(g.id)}" ${isChecked}><span title="${safeName}">${GROUP_ICON_SVG}${safeName}</span></label>`;
					}).join('');

					const isCustomShow = currentVis === 'custom' ? 'block' : 'none';

					await dialogs.setHtml(dialogHandle, `
						<style>
							.pub-form { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 13px; line-height: 1.4; color: var(--joplin-color, #d4d4d4); width: 100%; box-sizing: border-box; }
							.pub-form select { width: 100%; box-sizing: border-box; padding: 7px; font-size: 13px; border-radius: 4px; background: var(--joplin-background-color-2, #2a2e33); color: var(--joplin-color, #fff); border: 1px solid #3a3f45; outline: none; }
							.pub-desc { font-size: 11px; opacity: 0.7; margin-top: 5px; }
							.custom-box { border: 1px solid #3a3f45; border-radius: 6px; padding: 10px; background: #16181b; margin-top: 10px; }
							.list-box { max-height: 110px; overflow-y: auto; overflow-x: hidden; background: #0f1113; padding: 6px; border-radius: 4px; border: 1px solid #2a2e33; margin-top: 4px; }
							.check-item { display: flex; align-items: center; gap: 8px; margin: 3px 0; font-size: 12px; white-space: nowrap; overflow: hidden; }
							.check-item input { flex-shrink: 0; cursor: pointer; }
							.check-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
						</style>
						<div class="pub-form">
							<h3 style="margin-top:0; font-size:14px; word-break: break-word;">Publish: "${escapeHtml(rootPath || rootFolder.title)}"</h3>
							<form name="publishForm">
								<div style="margin-bottom: 10px;">
									<label style="display:block; font-weight:bold; margin-bottom:4px;">Visibility Level:</label>
									<select name="visibility" onchange="
										const desc = document.getElementById('visDesc');
										const box = document.getElementById('customOptionsBox');
										const notifyBox = document.getElementById('notifyBox');
										const notifyCaption = document.getElementById('notifyCaption');
										box.style.display = (this.value === 'custom' ? 'block' : 'none');
										notifyBox.style.display = (this.value === 'private' || this.value === 'custom') ? 'block' : 'none';
										if(this.value === 'private') notifyCaption.innerText = 'Will email all registered users.';
										else if(this.value === 'custom') notifyCaption.innerText = 'Will email only the newly added people.';
										if(this.value === 'public') desc.innerText = '🌍 Visible to anyone on the web without login.';
										else if(this.value === 'private') desc.innerText = '🔒 Visible to all authenticated registered users.';
										else if(this.value === 'custom') desc.innerText = '🎯 Restricted to selected groups and users below.';
										else if(this.value === 'remove') desc.innerText = '🗑️ Delete this notebook and its sub-notebooks from the web server.';
									">
										<option value="public" ${currentVis === 'public' ? 'selected' : ''}>🌍 Public</option>
										<option value="private" ${currentVis === 'private' ? 'selected' : ''}>🔒 Registered Users</option>
										<option value="custom" ${currentVis === 'custom' ? 'selected' : ''}>🎯 Custom Access</option>
										<option value="remove">🗑️ Unpublish</option>
									</select>
									<div id="visDesc" class="pub-desc">
										${currentVis === 'public' ? '🌍 Visible to anyone on the web without login.' : ''}
										${currentVis === 'private' ? '🔒 Visible to all authenticated registered users.' : ''}
										${currentVis === 'custom' ? '🎯 Restricted to selected groups and users below.' : ''}
									</div>
								</div>

								<div id="customOptionsBox" class="custom-box" style="display: ${isCustomShow};">
									<div style="margin-bottom: 10px;">
										<strong style="font-size:11px; color:#569cd6; text-transform:uppercase;">Authorized Groups:</strong>
										<div class="list-box">${groupsCheckboxes || '<span style="font-size:11px; opacity:0.5;">No groups available</span>'}</div>
									</div>
									<div>
										<strong style="font-size:11px; color:#569cd6; text-transform:uppercase;">Authorized Specific Users:</strong>
										<div class="list-box">${usersCheckboxes || '<span style="font-size:11px; opacity:0.5;">No users available</span>'}</div>
									</div>
								</div>

								<div id="notifyBox" style="display: ${(currentVis === 'private' || currentVis === 'custom') ? 'block' : 'none'}; margin-top: 10px;">
									<label class="check-item">
										<input type="checkbox" name="notifyNewPeople">
										<span>📧 Notify by email</span>
									</label>
									<div id="notifyCaption" class="pub-desc" style="margin-top:2px;">${currentVis === 'private' ? 'Will email all registered users.' : 'Will email only the newly added people.'}</div>
								</div>
							</form>
						</div>
					`);

					await dialogs.setButtons(dialogHandle, [{ id: 'ok', title: 'Confirm' }, { id: 'cancel', title: 'Cancel' }]);

					const result = await dialogs.open(dialogHandle);
					if (result.id === 'cancel') return;

					const formData = result.formData ? result.formData.publishForm : null;
					if (!formData) return;

					const visibility = formData.visibility;
					const allowedUsers: string[] = [];
					const allowedGroups: string[] = [];

					if (visibility === 'custom') {
						users.forEach((u, idx) => { if (formData[`user_${idx}`]) allowedUsers.push(u.email); });
						groups.forEach((g, idx) => { if (formData[`group_${idx}`]) allowedGroups.push(g.id); });

						if (allowedUsers.length === 0 && allowedGroups.length === 0) {
							currentVis = 'custom';
							currentAllowedUsers = [];
							currentAllowedGroups = [];
							await showMessage('⚠️ Please select at least one authorized group or user for Custom Access.');
							continue;
						}
					}

					// Per 'Registered Users' non esiste un elenco di destinatari specifico: la notifica,
					// se richiesta, va a tutti gli utenti registrati sul portale, senza calcolo di 'novità'
					// (il concetto stesso di 'nuovo' non si applica a questa visibilità). Per 'custom'
					// invece si notifica solo chi è davvero nuovo rispetto a prima di questa modifica —
					// non chi era già autorizzato individualmente o tramite un gruppo già presente, altrimenti
					// ogni ripubblicazione (es. dopo una modifica al contenuto) spammerebbe chi ha già accesso.
					let notifyEmails: string[] = [];
					if (visibility === 'private' && formData['notifyNewPeople']) {
						notifyEmails = users.map(u => u.email);
					} else if (visibility === 'custom' && formData['notifyNewPeople']) {
						const newlyAddedUserEmails = allowedUsers.filter(e => !currentAllowedUsers.includes(e));
						const newlyAddedGroupIds = allowedGroups.filter(gid => !currentAllowedGroups.includes(gid));

						const previouslyCoveredEmails = new Set<string>(currentAllowedUsers);
						groups.forEach(g => {
							if (currentAllowedGroups.includes(g.id) && Array.isArray(g.members)) {
								g.members.forEach((m: string) => previouslyCoveredEmails.add(m));
							}
						});

						const notifySet = new Set<string>();
						newlyAddedUserEmails.forEach(e => { if (!previouslyCoveredEmails.has(e)) notifySet.add(e); });
						newlyAddedGroupIds.forEach(gid => {
							const g = groups.find(gr => gr.id === gid);
							if (g && Array.isArray(g.members)) {
								g.members.forEach((m: string) => { if (!previouslyCoveredEmails.has(m)) notifySet.add(m); });
							}
						});

						notifyEmails = Array.from(notifySet);
					}

					try {
						let allNotes: any[] = [];
						if (visibility !== 'remove') {
							for (const tf of targetFolders) {
								let page = 1;
								let hasMore = true;
								while (hasMore) {
									const response = await joplin.data.get(['folders', tf.id, 'notes'], {
										fields: ['id', 'parent_id', 'title', 'body', 'updated_time', 'user_updated_time'],
										page: page++,
									});
									allNotes.push(...response.items);
									hasMore = response.has_more;
								}
							}
						}

						const foldersPayload = targetFolders.map(tf => ({
							id: tf.id,
							parent_id: tf.parent_id || '',
							title: tf.title,
							visibility: visibility,
							allowedUsers,
							allowedGroups
						}));

						const payload = {
							auth: auth,
							folders: foldersPayload,
							notes: allNotes,
							notifyEmails,
						};

						const apiResponse = await fetchWithTimeout(`${serverUrl}/api/publish`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify(payload),
						}, 10000);

						if (apiResponse.ok) {
							if (panelHandle && isPanelVisible) await renderPanelContent();
							const subCountMsg = targetFolders.length > 1 ? `<br><br><i>Included ${targetFolders.length - 1} sub-notebook(s).</i>` : '';
							const notifyMsg = notifyEmails.length > 0 ? `<br><br><i>📧 Email notification requested for ${notifyEmails.length} ${notifyEmails.length === 1 ? 'person' : 'people'}.</i>` : '';
							await showMessage(visibility === 'remove' 
								? `🗑️ Publication removed.${subCountMsg}` 
								: `✅ Notebook <b>"${escapeHtml(rootPath || rootFolder.title)}"</b> published successfully!${subCountMsg}${notifyMsg}`);
						} else {
							const resErr = await apiResponse.json();
							await showMessage(`❌ ${escapeHtml(resErr.error || 'Operation failed.')}`);
						}

					} catch (error: any) {
						await showMessage(`❌ Error: ${escapeHtml(error.message)}`);
					}

					break;
				}
			},
		});

		await joplin.views.menuItems.create('publishNotebookItem', 'publishNotebookToWeb', MenuItemLocation.FolderContextMenu);
		await joplin.views.menuItems.create('toggleWebPublisherPanelItem', 'toggleWebPublisherPanel', MenuItemLocation.View);
	},
});