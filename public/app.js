const state = {
  cartId: localStorage.getItem("cartId") || null,
};

function showError(message) {
  const banner = document.getElementById("error-banner");
  banner.textContent = message;
  banner.classList.remove("hidden");
  clearTimeout(showError._t);
  showError._t = setTimeout(() => banner.classList.add("hidden"), 5000);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = body?.error?.message || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body;
}

function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

function shortId(id) {
  return id ? id.split("-")[0] : "";
}

function setCartId(id) {
  state.cartId = id;
  if (id) {
    localStorage.setItem("cartId", id);
  } else {
    localStorage.removeItem("cartId");
  }
}

async function loadProducts() {
  const { products } = await api("/products");
  const body = document.getElementById("products-body");
  body.innerHTML = "";
  for (const product of products) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${product.name}</td>
      <td>${formatCents(product.priceCents)}</td>
      <td>${product.inventory}</td>
      <td><input type="number" min="1" value="1" id="qty-${product.id}" /></td>
      <td><button data-product-id="${product.id}" class="add-btn">Add to cart</button></td>
    `;
    body.appendChild(tr);
  }
  body.querySelectorAll(".add-btn").forEach((btn) => {
    btn.addEventListener("click", () => addToCart(Number(btn.dataset.productId)));
  });
}

async function ensureCart() {
  if (state.cartId) return state.cartId;
  const cart = await api("/carts", { method: "POST" });
  setCartId(cart.id);
  return cart.id;
}

async function addToCart(productId) {
  const qtyInput = document.getElementById(`qty-${productId}`);
  const quantity = Number(qtyInput.value) || 1;
  try {
    await ensureCart();
    await api(`/carts/${state.cartId}/items`, {
      method: "POST",
      body: JSON.stringify({ productId, quantity }),
    });
    await refreshCart();
    await loadProducts();
  } catch (err) {
    showError(err.message);
  }
}

async function createCart() {
  try {
    const cart = await api("/carts", { method: "POST" });
    setCartId(cart.id);
    document.getElementById("idempotency-key").value = "";
    document.getElementById("coupon-code").value = "";
    await refreshCart();
  } catch (err) {
    showError(err.message);
  }
}

async function refreshCart() {
  const label = document.getElementById("cart-id-label");
  const table = document.getElementById("cart-items-table");
  const subtotalEl = document.getElementById("cart-subtotal");
  const checkoutForm = document.getElementById("checkout-form");

  if (!state.cartId) {
    label.textContent = "No cart yet";
    label.title = "";
    document.getElementById("cart-status-badge").classList.add("hidden");
    table.classList.add("hidden");
    subtotalEl.classList.add("hidden");
    checkoutForm.classList.add("hidden");
    return;
  }

  let cart;
  try {
    cart = await api(`/carts/${state.cartId}`);
  } catch (err) {
    showError(err.message);
    setCartId(null);
    return refreshCart();
  }

  label.textContent = shortId(cart.id);
  label.title = cart.id;

  const statusBadge = document.getElementById("cart-status-badge");
  statusBadge.textContent = cart.status;
  statusBadge.className = `badge ${cart.status === "OPEN" ? "badge-open" : "badge-closed"}`;
  statusBadge.classList.remove("hidden");

  const body = document.getElementById("cart-items-body");
  body.innerHTML = "";
  for (const item of cart.items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${item.productName}</td>
      <td><input type="number" min="1" value="${item.quantity}" class="qty-edit" data-product-id="${item.productId}" /></td>
      <td>${formatCents(item.unitPriceCents)}</td>
      <td>${formatCents(item.lineTotalCents)}</td>
      <td><button class="danger remove-btn" data-product-id="${item.productId}">Remove</button></td>
    `;
    body.appendChild(tr);
  }
  table.classList.remove("hidden");
  subtotalEl.textContent = `Subtotal: ${formatCents(cart.subtotalCents)}`;
  subtotalEl.classList.remove("hidden");

  body.querySelectorAll(".qty-edit").forEach((input) => {
    input.addEventListener("change", () =>
      updateQuantity(Number(input.dataset.productId), Number(input.value)),
    );
  });
  body.querySelectorAll(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", () => removeItem(Number(btn.dataset.productId)));
  });

  if (cart.status === "OPEN" && cart.items.length > 0) {
    checkoutForm.classList.remove("hidden");
    const keyInput = document.getElementById("idempotency-key");
    if (!keyInput.value) {
      keyInput.value = crypto.randomUUID();
    }
  } else {
    checkoutForm.classList.add("hidden");
  }
}

async function updateQuantity(productId, quantity) {
  try {
    await api(`/carts/${state.cartId}/items/${productId}`, {
      method: "PATCH",
      body: JSON.stringify({ quantity }),
    });
    await refreshCart();
    await loadProducts();
  } catch (err) {
    showError(err.message);
    await refreshCart();
  }
}

async function removeItem(productId) {
  try {
    await api(`/carts/${state.cartId}/items/${productId}`, { method: "DELETE" });
    await refreshCart();
    await loadProducts();
  } catch (err) {
    showError(err.message);
  }
}

async function checkout() {
  const key = document.getElementById("idempotency-key").value.trim();
  const couponCode = document.getElementById("coupon-code").value.trim();
  if (!key) {
    showError("Idempotency key is required.");
    return;
  }
  try {
    const order = await api(`/carts/${state.cartId}/checkout`, {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify(couponCode ? { couponCode } : {}),
    });
    document.getElementById("order-section").classList.remove("hidden");
    renderOrder(order);
    document.getElementById("order-output").textContent = JSON.stringify(order, null, 2);
    setCartId(null);
    await refreshCart();
    await loadProducts();
    await refreshOrdersPlaced();
  } catch (err) {
    showError(err.message);
  }
}

async function refreshOrdersPlaced() {
  try {
    const report = await api("/admin/report");
    const badge = document.getElementById("orders-placed-badge");
    badge.textContent = `${report.totalOrders} order${report.totalOrders === 1 ? "" : "s"} placed`;
    badge.classList.remove("hidden");
  } catch {
    // Non-critical stat; ignore failures silently.
  }
}

async function generateCoupon() {
  try {
    const coupon = await api("/admin/coupons/generate", { method: "POST" });
    renderCoupon(coupon);
    document.getElementById("admin-output").textContent = JSON.stringify(coupon, null, 2);
  } catch (err) {
    showError(err.message);
  }
}

async function loadReport() {
  try {
    const report = await api("/admin/report");
    renderReport(report);
    document.getElementById("admin-output").textContent = JSON.stringify(report, null, 2);
  } catch (err) {
    showError(err.message);
  }
}

function renderOrder(order) {
  document.getElementById("order-id").textContent = shortId(order.id);
  document.getElementById("order-id").title = order.id;
  document.getElementById("order-date").textContent = formatDate(order.createdAt);

  const body = document.getElementById("order-lines-body");
  body.innerHTML = "";
  for (const line of order.lines) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${line.productName}</td>
      <td>${line.quantity}</td>
      <td>${formatCents(line.unitPriceCents)}</td>
      <td>${formatCents(line.lineTotalCents)}</td>
    `;
    body.appendChild(tr);
  }

  document.getElementById("order-subtotal").textContent = formatCents(order.subtotalCents);

  const discountRow = document.getElementById("order-discount-row");
  if (order.discountCents > 0) {
    discountRow.classList.remove("hidden");
    document.getElementById("order-discount").textContent = `-${formatCents(order.discountCents)}`;
    document.getElementById("order-coupon-badge").textContent = order.couponCode || "";
  } else {
    discountRow.classList.add("hidden");
  }

  document.getElementById("order-total").textContent = formatCents(order.totalCents);
}

function renderCoupon(coupon) {
  const card = document.getElementById("coupon-card");
  card.classList.remove("hidden");
  document.getElementById("coupon-milestone").textContent = coupon.milestoneNumber;
  document.getElementById("coupon-code-display").textContent = coupon.code;
  document.getElementById("coupon-percent").textContent = `${coupon.percentOff}%`;

  const statusEl = document.getElementById("coupon-status");
  statusEl.textContent = coupon.status;
  statusEl.className = `badge ${coupon.status === "AVAILABLE" ? "badge-open" : "badge-closed"}`;
}

function renderReport(report) {
  const card = document.getElementById("report-card");
  card.classList.remove("hidden");

  const stats = [
    { label: "Total orders", value: report.totalOrders },
    { label: "Gross revenue", value: formatCents(report.grossRevenueCents) },
    { label: "Total discount", value: formatCents(report.totalDiscountCents) },
    { label: "Net revenue", value: formatCents(report.netRevenueCents) },
    { label: "Coupons generated", value: report.coupons.generated },
    { label: "Coupons available", value: report.coupons.available },
    { label: "Coupons redeemed", value: report.coupons.redeemed },
  ];

  const statsEl = document.getElementById("report-stats");
  statsEl.innerHTML = stats
    .map(
      (stat) => `
        <div class="stat-tile">
          <span class="stat-value">${stat.value}</span>
          <span class="stat-label">${stat.label}</span>
        </div>
      `,
    )
    .join("");

  const table = document.getElementById("report-products-table");
  const body = document.getElementById("report-products-body");
  body.innerHTML = "";
  for (const row of report.quantityByProduct) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.productName}</td><td>${row.quantity}</td>`;
    body.appendChild(tr);
  }
  table.classList.toggle("hidden", report.quantityByProduct.length === 0);
}

document.getElementById("new-cart-btn").addEventListener("click", createCart);
document.getElementById("checkout-btn").addEventListener("click", checkout);
document.getElementById("generate-coupon-btn").addEventListener("click", generateCoupon);
document.getElementById("load-report-btn").addEventListener("click", loadReport);

loadProducts();
refreshCart();
refreshOrdersPlaced();
