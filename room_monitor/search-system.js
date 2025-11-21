
// Configuration
const API_BASE_URL = 'http://localhost:3000';

// Helper functions
function parseTimestamp(ts) {
    if (ts === null || ts === undefined) return null;
    if (ts instanceof Date) return isNaN(ts.getTime()) ? null : ts;
    if (typeof ts === 'number') {
        const ms = ts < 1e12 ? ts * 1000 : ts;
        const d = new Date(ms);
        return isNaN(d.getTime()) ? null : d;
    }
    if (typeof ts === 'string') {
        const num = Number(ts);
        if (!Number.isNaN(num)) return parseTimestamp(num);
        const isoLike = ts.includes(' ') && !ts.includes('T') ? ts.replace(' ', 'T') : ts;
        const d = new Date(isoLike);
        return isNaN(d.getTime()) ? null : d;
    }
    return null;
}

function formatTimestamp(ts) {
    const d = parseTimestamp(ts);
    if (!d) return '-';
    const pad = (n) => String(n).padStart(2, '0');
    const dd = pad(d.getDate());
    const mm = pad(d.getMonth() + 1);
    const yyyy = d.getFullYear();
    const HH = pad(d.getHours());
    const MM = pad(d.getMinutes());
    const SS = pad(d.getSeconds());
    return `${dd}/${mm}/${yyyy} ${HH}:${MM}:${SS}`;
}

// Global search state
const searchState = {
    sensor: {
        currentPage: 1,
        limit: 10, // Giảm từ 20 xuống 10 để load nhanh hơn
        searchTerm: '',
        searchField: 'all',
        loading: false
    },
    action: {
        currentPage: 1,
        limit: 10, // Giảm từ 20 xuống 10 để load nhanh hơn
        searchTerm: '',
        searchField: 'all',
        loading: false
    }
};

// ===== SENSOR LOG FUNCTIONS =====
async function loadSensorData() {
    const state = searchState.sensor;
    if (state.loading) return;
    
    try {
        state.loading = true;
        showSensorLoading();
        
        // Build URL
        const params = new URLSearchParams({
            page: state.currentPage,
            limit: state.limit
        });
        // Thêm search nếu có (hỗ trợ field=time với dd/mm/yyyy hh:mm:ss hoặc prefix)
        if (state.searchTerm.trim()) {
            params.append('search', state.searchTerm.trim());
            params.append('field', state.searchField || 'all');
        }
        const response = await fetch(`${API_BASE_URL}/api/sensors?${params}`);
        const data = await response.json();
        
        if (data && data.success) {
            renderSensorTable(Array.isArray(data.data) ? data.data : []);
            renderSensorPagination(data.pagination);
        } else {
            showSensorError('Lỗi tải dữ liệu sensor');
        }
        
    } catch (error) {
        console.error('Lỗi tải dữ liệu Sensor');
        showSensorError('Không thể tải dữ liệu');
    } finally {
        state.loading = false;
    }
}

function renderSensorTable(data) {
    const tbody = document.getElementById('sensorLogTableBody');
    if (!tbody) return;
    
    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="no-data">Không có dữ liệu</td></tr>';
        return;
    }
    
    tbody.innerHTML = data.map(row => `
        <tr>
            <td>${row.id_data}</td>
            <td>${row.t}°C</td>
            <td>${row.h}%</td>
            <td>${row.lux}lux</td>
            <td>${formatTimestamp(row.time_stamp)}</td>
        </tr>
    `).join('');
}

function renderSensorPagination(pagination) {
    const container = document.querySelector('#sensorLogTableBody')?.closest('.table-container')?.nextElementSibling?.querySelector('.pagination');
    if (!container || !pagination) return;
    
    const { currentPage, totalPages, hasNext, hasPrev } = pagination;
    const page = currentPage || 1;
    
    let html = '';
    
    // Previous button
    html += `<button class="pagination-btn" ${!hasPrev ? 'disabled' : ''} onclick="changeSensorPage(${page - 1})">‹ Prev</button>`;
    
    // Page numbers
    const startPage = Math.max(1, page - 2);
    const endPage = Math.min(totalPages, page + 2);
    
    for (let i = startPage; i <= endPage; i++) {
        html += `<button class="pagination-btn ${i === page ? 'active' : ''}" onclick="changeSensorPage(${i})">${i}</button>`;
    }
    
    // Next button
    html += `<button class="pagination-btn" ${!hasNext ? 'disabled' : ''} onclick="changeSensorPage(${page + 1})">Next ›</button>`;
    
    container.innerHTML = html;
}

function changeSensorPage(newPage) {
    searchState.sensor.currentPage = newPage;
    loadSensorData();
}

function showSensorLoading() {
    const tbody = document.getElementById('sensorLogTableBody');
    if (tbody) {
        tbody.innerHTML = '<tr><td colspan="5" class="loading">Đang tải...</td></tr>';
    }
}

function showSensorError(message) {
    const tbody = document.getElementById('sensorLogTableBody');
    if (tbody) {
        tbody.innerHTML = `<tr><td colspan="5" class="error">${message}</td></tr>`;
    }
}

// ===== ACTION LOG FUNCTIONS =====
async function loadActionData() {
    const state = searchState.action;
    if (state.loading) return;
    
    try {
        state.loading = true;
        showActionLoading();
        
        // Build URL
        const params = new URLSearchParams({
            page: state.currentPage,
            limit: state.limit
        });
        
        if (state.searchTerm.trim()) {
            // Backend /api/actions sử dụng 'search' và 'field'
            params.append('search', state.searchTerm);
            params.append('field', state.searchField);
        }
        
        const response = await fetch(`${API_BASE_URL}/api/actions?${params}`);
        const data = await response.json();
        
        if (data && data.success) {
            renderActionTable(Array.isArray(data.data) ? data.data : []);
            renderActionPagination(data.pagination);
        } else {
            showActionError('Lỗi tải dữ liệu action');
        }
        
    } catch (error) {
        console.error('Lỗi tải dữ liệu Action');
        showActionError('Không thể tải dữ liệu');
    } finally {
        state.loading = false;
    }
}

function renderActionTable(data) {
    const tbody = document.getElementById('actionLogTableBody');
    if (!tbody) return;
    
    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="no-data">Không có dữ liệu</td></tr>';
        return;
    }
    
    tbody.innerHTML = data.map(row => {
        const actionClass = row.action === 'ON' ? 'status-on' : 'status-off';
        const idVal = (row.id_action ?? row.id ?? '');
        return `
            <tr>
                <td>${idVal}</td>
                <td class="actor-user">${row.actor}</td>
                <td>${row.device}</td>
                <td><span class="${actionClass}">${row.action}</span></td>
                <td>${formatTimestamp(row.time_stamp)}</td>
            </tr>
        `;
    }).join('');
}

function renderActionPagination(pagination) {
    const container = document.querySelector('#actionLogTableBody')?.closest('.table-container')?.nextElementSibling?.querySelector('.pagination');
    if (!container || !pagination) return;
    
    const { currentPage, totalPages, hasNext, hasPrev } = pagination;
    const page = currentPage || 1;
    
    let html = '';
    
    // Previous button
    html += `<button class="pagination-btn" ${!hasPrev ? 'disabled' : ''} onclick="changeActionPage(${page - 1})">‹ Prev</button>`;
    
    // Page numbers
    const startPage = Math.max(1, page - 2);
    const endPage = Math.min(totalPages, page + 2);
    
    for (let i = startPage; i <= endPage; i++) {
        html += `<button class="pagination-btn ${i === page ? 'active' : ''}" onclick="changeActionPage(${i})">${i}</button>`;
    }
    
    // Next button
    html += `<button class="pagination-btn" ${!hasNext ? 'disabled' : ''} onclick="changeActionPage(${page + 1})">Next ›</button>`;
    
    container.innerHTML = html;
}

function changeActionPage(newPage) {
    searchState.action.currentPage = newPage;
    loadActionData();
}

function showActionLoading() {
    const tbody = document.getElementById('actionLogTableBody');
    if (tbody) {
        tbody.innerHTML = '<tr><td colspan="5" class="loading">Đang tải...</td></tr>';
    }
}

function showActionError(message) {
    const tbody = document.getElementById('actionLogTableBody');
    if (tbody) {
        tbody.innerHTML = `<tr><td colspan="5" class="error">${message}</td></tr>`;
    }
}

// ===== SEARCH SETUP =====
function setupSensorSearch() {
    const searchInput = document.getElementById('sensorSearchInput');
    const searchField = document.getElementById('sensorSearchField');
    const recordsSelector = document.getElementById('recordsPerPage');
    
    if (searchInput && searchField) {
        let timeout;
        
        // Search input với debounce 500ms
        searchInput.addEventListener('input', () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                searchState.sensor.searchTerm = searchInput.value.trim();
                searchState.sensor.currentPage = 1;
                loadSensorData();
            }, 500);
        });
        
        // Search field change
        searchField.addEventListener('change', () => {
            searchState.sensor.searchField = searchField.value;
            searchState.sensor.currentPage = 1;
            loadSensorData();
        });
    }
    
    // Records per page
    if (recordsSelector) {
        recordsSelector.addEventListener('change', () => {
            searchState.sensor.limit = parseInt(recordsSelector.value) || 20;
            searchState.sensor.currentPage = 1;
            loadSensorData();
        });
    }
}

function setupActionSearch() {
    const searchInput = document.getElementById('actionSearchInput');
    const searchField = document.getElementById('actionSearchField');
    const recordsSelector = document.getElementById('actionRecordsPerPage');
    
    if (searchInput && searchField) {
        let timeout;
        
        // Search input với debounce 500ms
        searchInput.addEventListener('input', () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                searchState.action.searchTerm = searchInput.value.trim();
                searchState.action.currentPage = 1;
                loadActionData();
            }, 500);
        });
        
        // Search field change
        searchField.addEventListener('change', () => {
            searchState.action.searchField = searchField.value;
            searchState.action.currentPage = 1;
            loadActionData();
        });
    }
    
    // Records per page
    if (recordsSelector) {
        recordsSelector.addEventListener('change', () => {
            searchState.action.limit = parseInt(recordsSelector.value) || 20;
            searchState.action.currentPage = 1;
            loadActionData();
        });
    }
}

// ===== INITIALIZATION =====
function initializeSearchSystem() {
    // Setup Sensor Log if exists
    if (document.getElementById('sensorLogTableBody')) {
        setupSensorSearch();
        loadSensorData();
    }
    
    // Setup Action Log if exists  
    if (document.getElementById('actionLogTableBody')) {
        setupActionSearch();
        loadActionData();
    }
    
    // Expose global functions
    window.changeSensorPage = changeSensorPage;
    window.changeActionPage = changeActionPage;
}

// Auto-initialize when DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeSearchSystem);
} else {
    initializeSearchSystem();
}