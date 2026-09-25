export interface Product {
  id: number;
  name: string;
  priceCents: number;
  inventory: number;
}

export type CartStatus = "OPEN" | "CHECKED_OUT";

export interface Cart {
  id: string;
  status: CartStatus;
  createdAt: string;
}

export interface CartItemRow {
  cartId: string;
  productId: number;
  quantity: number;
}

export interface CartItemView {
  productId: number;
  productName: string;
  quantity: number;
  unitPriceCents: number;
  availableInventory: number;
  lineTotalCents: number;
}

export interface CartView {
  id: string;
  status: CartStatus;
  createdAt: string;
  items: CartItemView[];
  subtotalCents: number;
}

export type CouponStatus = "AVAILABLE" | "REDEEMED";

export interface Coupon {
  id: string;
  code: string;
  milestoneNumber: number;
  percentOff: number;
  status: CouponStatus;
  redeemedByOrderId: string | null;
  createdAt: string;
  redeemedAt: string | null;
}

export interface OrderLine {
  productId: number;
  productName: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface Order {
  id: string;
  cartId: string;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  couponId: string | null;
  couponCode: string | null;
  createdAt: string;
  lines: OrderLine[];
}

export interface AdminReport {
  totalOrders: number;
  quantityByProduct: { productId: number; productName: string; quantity: number }[];
  grossRevenueCents: number;
  totalDiscountCents: number;
  netRevenueCents: number;
  coupons: {
    generated: number;
    available: number;
    redeemed: number;
  };
}
