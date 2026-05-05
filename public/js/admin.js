// admin.js — 관리자 도메인 화이트리스트 관리

import { db, ADMIN_EMAIL } from './auth.js';
import { doc, getDoc, setDoc, updateDoc, arrayUnion, arrayRemove }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const DOMAINS_REF = () => doc(db, 'config', 'allowedDomains');

const $ = id => document.getElementById(id);

export async function initAdmin(user) {
  // 관리자 본인 계정 표시
  $('admin-email').textContent = user.email;

  await renderDomainList();

  $('btn-add-domain').addEventListener('click', addDomain);
  $('domain-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addDomain();
  });
}

async function fetchDomains() {
  const snap = await getDoc(DOMAINS_REF());
  if (snap.exists()) return snap.data().domains ?? [];
  return [];
}

async function renderDomainList() {
  const list = $('domain-list');
  list.innerHTML = '<li class="domain-loading">불러오는 중...</li>';

  const domains = await fetchDomains();
  list.innerHTML = '';

  if (domains.length === 0) {
    list.innerHTML = '<li class="domain-empty">등록된 도메인이 없습니다.</li>';
    return;
  }

  domains.forEach(domain => {
    const li = document.createElement('li');
    li.className = 'domain-item';
    li.innerHTML = `
      <span class="domain-name">@${domain}</span>
      <button class="btn-delete-domain btn-ghost" data-domain="${domain}">삭제</button>
    `;
    li.querySelector('.btn-delete-domain').addEventListener('click', () => deleteDomain(domain));
    list.appendChild(li);
  });
}

async function addDomain() {
  const input = $('domain-input');
  let value = input.value.trim().toLowerCase().replace(/^@/, '');

  if (!value) return;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) {
    $('domain-error').textContent = '올바른 도메인 형식을 입력하세요. (예: sunyu.hs.kr)';
    return;
  }

  $('domain-error').textContent = '';
  $('btn-add-domain').disabled = true;

  try {
    const ref = DOMAINS_REF();
    const snap = await getDoc(ref);
    if (snap.exists()) {
      await updateDoc(ref, { domains: arrayUnion(value) });
    } else {
      await setDoc(ref, { domains: [value] });
    }
    input.value = '';
    await renderDomainList();
  } catch (e) {
    $('domain-error').textContent = '저장 실패: ' + e.message;
  } finally {
    $('btn-add-domain').disabled = false;
  }
}

async function deleteDomain(domain) {
  if (!confirm(`@${domain} 도메인을 삭제하시겠습니까?\n해당 도메인 학생들은 더 이상 접속할 수 없습니다.`)) return;

  try {
    await updateDoc(DOMAINS_REF(), { domains: arrayRemove(domain) });
    await renderDomainList();
  } catch (e) {
    alert('삭제 실패: ' + e.message);
  }
}
