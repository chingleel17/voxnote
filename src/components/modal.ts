export interface ModalOptions {
  title: string;
  content: string | HTMLElement;
  confirmText?: string;
  cancelText?: string;
  /** 回傳 false 可阻止 modal 關閉（用於驗證失敗） */
  onConfirm?: () => boolean | void | Promise<boolean | void>;
  onCancel?: () => void;
}

let modalOverlay: HTMLElement | null = null;

export function openModal(options: ModalOptions): void {
  closeModal();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';

  const header = document.createElement('div');
  header.className = 'modal-header';

  const title = document.createElement('h3');
  title.className = 'modal-title';
  title.textContent = options.title;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => {
    options.onCancel?.();
    closeModal();
  });

  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'modal-body';
  if (typeof options.content === 'string') {
    body.innerHTML = options.content;
  } else {
    body.appendChild(options.content);
  }

  const footer = document.createElement('div');
  footer.className = 'modal-footer';

  if (options.cancelText !== undefined) {
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = options.cancelText || '取消';
    cancelBtn.addEventListener('click', () => {
      options.onCancel?.();
      closeModal();
    });
    footer.appendChild(cancelBtn);
  }

  if (options.onConfirm) {
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn btn-primary';
    confirmBtn.textContent = options.confirmText || '確認';
    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      const result = await options.onConfirm?.();
      if (result === false) {
        confirmBtn.disabled = false;
        return;
      }
      closeModal();
    });
    footer.appendChild(confirmBtn);
  }

  modal.appendChild(header);
  modal.appendChild(body);
  if (footer.children.length > 0) {
    modal.appendChild(footer);
  }

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  modalOverlay = overlay;

  // 點擊遮罩關閉
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      options.onCancel?.();
      closeModal();
    }
  });

  requestAnimationFrame(() => overlay.classList.add('modal-visible'));
}

export function closeModal(): void {
  if (modalOverlay) {
    modalOverlay.remove();
    modalOverlay = null;
  }
}
