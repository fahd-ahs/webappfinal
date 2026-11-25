import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import api from '../../lib/api';
import {
  CreditCard,
  Download,
  Clock,
  CheckCircle,
  AlertTriangle,
  XCircle,
  FileText,
  Search,
  Eye,
  IndianRupee,
  Calendar,
  ShieldCheck,
  Smartphone,
  Landmark,
  Receipt,
  ArrowRight,
  X,
  GraduationCap,
  History,
  Wallet,
} from 'lucide-react';

const containerV = { animate: { transition: { staggerChildren: 0.05, delayChildren: 0.05 } } };
const cardV = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } },
};

const statusConfig = {
  PAID: {
    bg: 'bg-emerald-500/12',
    border: 'border-emerald-500/25',
    text: 'text-emerald-400',
    dot: 'bg-emerald-400',
    icon: CheckCircle,
    label: 'Paid',
  },
  UNPAID: {
    bg: 'bg-amber-500/12',
    border: 'border-amber-500/25',
    text: 'text-amber-400',
    dot: 'bg-amber-400',
    icon: Clock,
    label: 'Pending',
  },
  PARTIAL: {
    bg: 'bg-indigo-500/12',
    border: 'border-indigo-500/25',
    text: 'text-indigo-400',
    dot: 'bg-indigo-400',
    icon: AlertTriangle,
    label: 'Partially Paid',
  },
  OVERDUE: {
    bg: 'bg-rose-500/12',
    border: 'border-rose-500/25',
    text: 'text-rose-400',
    dot: 'bg-rose-400',
    icon: XCircle,
    label: 'Overdue',
  },
};

const DEMO_METHODS = [
  {
    id: 'UPI',
    label: 'UPI (Demo)',
    subtitle: 'Instant simulated UPI handle verification',
    icon: Smartphone,
    accent: 'text-cyan-400',
    presets: ['student@demoupi', 'parent@demoupi'],
  },
  {
    id: 'CARD',
    label: 'Debit / Credit Card (Demo)',
    subtitle: 'Simulated tokenized card test instrument',
    icon: CreditCard,
    accent: 'text-indigo-400',
    presets: ['Demo Visa •••• 4242', 'Demo RuPay •••• 8810'],
  },
  {
    id: 'NET_BANKING',
    label: 'Net Banking (Demo)',
    subtitle: 'Simulated institutional bank transfer',
    icon: Landmark,
    accent: 'text-emerald-400',
    presets: ['Demo National Bank', 'Demo Campus Bank', 'Demo Federal Bank'],
  },
];

function formatCurrency(amount) {
  const value = Number(amount) || 0;
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function createIdempotencyKey() {
  if (typeof window !== 'undefined' && window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `demo-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function formatMethodLabel(method) {
  if (method === 'NET_BANKING') return 'Net Banking';
  if (method === 'CARD') return 'Card';
  return 'UPI';
}

export default function Payments() {
  const [data, setData] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [accessError, setAccessError] = useState(null);

  const [activeTab, setActiveTab] = useState('invoices');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  const [detailInvoice, setDetailInvoice] = useState(null);
  const [checkoutInvoice, setCheckoutInvoice] = useState(null);
  const [checkoutStep, setCheckoutStep] = useState('review'); // 'review' | 'method' | 'success'
  const [paymentMode, setPaymentMode] = useState('FULL'); // 'FULL' | 'PARTIAL'
  const [customAmount, setCustomAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('UPI');
  const [methodDetail, setMethodDetail] = useState('student@demoupi');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [submittingPayment, setSubmittingPayment] = useState(false);
  const [confirmedResult, setConfirmedResult] = useState(null);

  const [downloadingKey, setDownloadingKey] = useState(null);

  const loadBillingData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [invRes, txnRes] = await Promise.all([
        api.get('/payments/invoices'),
        api.get('/payments/transactions'),
      ]);
      setData(invRes.data);
      setTransactions(txnRes.data?.transactions || []);
      setAccessError(null);
    } catch (err) {
      const msg = err.response?.data?.detail || 'Unable to load payment records.';
      if (err.response?.status === 403) {
        setAccessError(msg);
      } else {
        toast.error(msg);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBillingData();
  }, [loadBillingData]);

  const openInvoiceDetail = async (invoice) => {
    setDetailInvoice(invoice);
    try {
      const { data: fresh } = await api.get(`/payments/invoices/${invoice.id}`);
      setDetailInvoice(fresh);
    } catch {
      // Keep snapshot if refresh fails
    }
  };

  const openCheckoutModal = (invoice) => {
    const balance = Number(invoice.balance_due ?? Math.max(0, invoice.total_amount - invoice.amount_paid));
    if (balance <= 0) {
      toast.info('This invoice has already been paid in full.');
      return;
    }
    setDetailInvoice(null);
    setCheckoutInvoice(invoice);
    setCheckoutStep('review');
    setPaymentMode('FULL');
    setCustomAmount(String(balance));
    setPaymentMethod('UPI');
    const firstName = (invoice.student_name || 'student').split(' ')[0].toLowerCase();
    setMethodDetail(`${firstName}@demoupi`);
    setIdempotencyKey(createIdempotencyKey());
    setConfirmedResult(null);
  };

  const closeCheckoutModal = () => {
    if (submittingPayment) return;
    setCheckoutInvoice(null);
    setConfirmedResult(null);
  };

  const handleMethodSelect = (methodId) => {
    setPaymentMethod(methodId);
    const meta = DEMO_METHODS.find((m) => m.id === methodId);
    if (methodId === 'UPI' && checkoutInvoice?.student_name) {
      const firstName = checkoutInvoice.student_name.split(' ')[0].toLowerCase();
      setMethodDetail(`${firstName}@demoupi`);
    } else if (meta?.presets?.length) {
      setMethodDetail(meta.presets[0]);
    }
  };

  const downloadInvoicePdf = async (invoice) => {
    const key = `inv-${invoice.id}`;
    setDownloadingKey(key);
    try {
      const response = await api.get(`/payments/invoices/${invoice.id}/pdf`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${invoice.invoice_number || invoice.id}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success(`Downloaded ${invoice.invoice_number}.pdf`);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to download invoice PDF');
    } finally {
      setDownloadingKey(null);
    }
  };

  const downloadReceiptPdf = async (txn) => {
    const key = `rcpt-${txn.id}`;
    setDownloadingKey(key);
    try {
      const response = await api.get(`/payments/transactions/${txn.id}/receipt/pdf`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${txn.receipt_number || txn.id}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success(`Downloaded ${txn.receipt_number}.pdf`);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to download receipt PDF');
    } finally {
      setDownloadingKey(null);
    }
  };

  const payableAmount = useMemo(() => {
    if (!checkoutInvoice) return 0;
    const balance = Number(
      checkoutInvoice.balance_due ?? Math.max(0, checkoutInvoice.total_amount - checkoutInvoice.amount_paid)
    );
    if (paymentMode === 'FULL') return balance;
    const parsed = Number(customAmount);
    return Number.isFinite(parsed) ? Math.round((parsed + Number.EPSILON) * 100) / 100 : 0;
  }, [checkoutInvoice, paymentMode, customAmount]);

  const handleConfirmDemoPayment = async () => {
    if (!checkoutInvoice || submittingPayment) return;
    const balance = Number(
      checkoutInvoice.balance_due ?? Math.max(0, checkoutInvoice.total_amount - checkoutInvoice.amount_paid)
    );
    if (!Number.isFinite(payableAmount) || payableAmount <= 0 || payableAmount > balance) {
      toast.error(`Enter a valid amount between Rs.1 and Rs.${formatCurrency(balance)}.`);
      return;
    }

    setSubmittingPayment(true);
    try {
      const { data: res } = await api.post(`/payments/invoices/${checkoutInvoice.id}/pay`, {
        amount: payableAmount,
        payment_method: paymentMethod,
        method_detail: methodDetail,
        idempotency_key: idempotencyKey,
      });
      setConfirmedResult(res);
      setCheckoutStep('success');
      toast.success('Demo payment confirmed. Receipt ready for download.');
      await loadBillingData(true);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Unable to process demo payment');
    } finally {
      setSubmittingPayment(false);
    }
  };

  const invoices = useMemo(() => data?.invoices || [], [data]);
  const summary = useMemo(() => data?.summary || {}, [data]);
  const schoolIdentity = useMemo(
    () =>
      data?.school_identity || {
        name: 'The Oxford School',
        department: 'Academic Fee & Billing Office',
        address: '14 Innovation Campus, Bengaluru 560001',
        email: 'billing@theoxfordschool.edu',
        phone: '+91 80 4120 2026',
        gstin: '29AABCS2026E1Z5',
        academic_year: '2026-27',
      },
    [data]
  );

  const filteredInvoices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return invoices.filter((inv) => {
      if (statusFilter !== 'ALL' && inv.status !== statusFilter) return false;
      if (!q) return true;
      return (
        (inv.invoice_number || '').toLowerCase().includes(q) ||
        (inv.category || '').toLowerCase().includes(q) ||
        (inv.student_name || '').toLowerCase().includes(q)
      );
    });
  }, [invoices, statusFilter, searchQuery]);

  const filterTabs = useMemo(
    () => [
      { key: 'ALL', label: 'All Invoices', count: invoices.length },
      { key: 'PAID', label: 'Paid', count: summary.paid_count || 0 },
      { key: 'UNPAID', label: 'Pending', count: summary.unpaid_count || 0 },
      { key: 'PARTIAL', label: 'Partially Paid', count: summary.partial_count || 0 },
      { key: 'OVERDUE', label: 'Overdue', count: summary.overdue_count || 0 },
    ],
    [invoices.length, summary]
  );

  const totalBilled = summary.total_billed || 0;
  const allocationSegments = useMemo(() => {
    if (totalBilled <= 0) return [];
    return [
      {
        key: 'paid',
        label: 'Paid',
        amount: summary.total_paid || 0,
        color: 'bg-emerald-500',
        text: 'text-emerald-400',
      },
      {
        key: 'partial',
        label: 'Partial Balance',
        amount: summary.partial_balance || 0,
        color: 'bg-indigo-500',
        text: 'text-indigo-400',
      },
      {
        key: 'pending',
        label: 'Pending',
        amount: summary.pending_balance || 0,
        color: 'bg-amber-500',
        text: 'text-amber-400',
      },
      {
        key: 'overdue',
        label: 'Overdue',
        amount: summary.overdue_balance || 0,
        color: 'bg-rose-500',
        text: 'text-rose-400',
      },
    ];
  }, [totalBilled, summary]);

  if (loading) return <PaymentsSkeleton />;

  if (accessError) {
    return (
      <div className="glass-card p-10 text-center max-w-xl mx-auto mt-8">
        <ShieldCheck className="w-10 h-10 text-amber-400 mx-auto mb-3" />
        <h2 className="text-lg font-bold font-['Outfit'] mb-1">Billing Access Restricted</h2>
        <p className="text-sm text-[var(--text-muted)]">{accessError}</p>
      </div>
    );
  }

  return (
    <motion.div
      data-testid="payments-page"
      variants={containerV}
      initial="initial"
      animate="animate"
      className="space-y-6"
    >
      {/* Header + Exhibition Demo Notice */}
      <motion.div
        variants={cardV}
        className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4"
      >
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 flex items-center justify-center shadow-[0_0_20px_rgba(99,102,241,0.3)]">
              <CreditCard className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold font-['Outfit'] tracking-tight">
                Fee &amp; Payment Centre
              </h1>
              <p className="text-[var(--text-muted)] text-sm">
                {schoolIdentity.name} · Academic Year {schoolIdentity.academic_year}
              </p>
            </div>
          </div>
        </div>

        <div
          data-testid="demo-mode-banner"
          className="inline-flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-indigo-500/10 border border-indigo-400/25 text-xs text-indigo-200 self-start lg:self-auto"
        >
          <ShieldCheck className="w-4 h-4 text-cyan-400 shrink-0" />
          <span>
            <strong className="font-semibold text-white">Exhibition Demonstration</strong> — No real money will be charged.
          </span>
        </div>
      </motion.div>

      {/* Financial Overview KPI Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
        <motion.div variants={cardV} className="glass-card p-5 border-white/[0.08]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider font-medium">
              Total Billed
            </span>
            <Wallet className="w-4 h-4 text-slate-400" />
          </div>
          <p className="text-2xl font-bold font-mono text-white" data-testid="total-billed">
            <IndianRupee className="w-4 h-4 inline -mt-1 mr-0.5" />
            {formatCurrency(summary.total_billed)}
          </p>
          <p className="text-xs text-[var(--text-muted)] mt-1">{invoices.length} total invoices</p>
        </motion.div>

        <motion.div variants={cardV} className="glass-card p-5 hover:border-emerald-500/25">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider font-medium">
              Total Paid
            </span>
            <CheckCircle className="w-4 h-4 text-emerald-400" />
          </div>
          <p className="text-2xl font-bold font-mono text-emerald-400" data-testid="total-paid">
            <IndianRupee className="w-4 h-4 inline -mt-1 mr-0.5" />
            {formatCurrency(summary.total_paid)}
          </p>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            {summary.paid_count || 0} settled · {summary.partial_count || 0} partial
          </p>
        </motion.div>

        <motion.div variants={cardV} className="glass-card p-5 hover:border-rose-500/25">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider font-medium">
              Outstanding Balance
            </span>
            <AlertTriangle className="w-4 h-4 text-rose-400" />
          </div>
          <p
            className={`text-2xl font-bold font-mono ${(summary.outstanding_balance || 0) > 0 ? 'text-rose-400' : 'text-emerald-400'}`}
            data-testid="total-due"
          >
            <IndianRupee className="w-4 h-4 inline -mt-1 mr-0.5" />
            {formatCurrency(summary.outstanding_balance)}
          </p>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            {(summary.overdue_balance || 0) > 0
              ? `Includes Rs.${formatCurrency(summary.overdue_balance)} overdue`
              : 'No overdue balance'}
          </p>
        </motion.div>

        <motion.div variants={cardV} className="glass-card p-5 hover:border-amber-500/25">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider font-medium">
              Pending Invoices
            </span>
            <FileText className="w-4 h-4 text-amber-400" />
          </div>
          <p className="text-2xl font-bold font-mono text-amber-400" data-testid="pending-count">
            {summary.pending_invoices_count || 0}
          </p>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            {summary.overdue_count || 0} overdue · {summary.unpaid_count || 0} upcoming
          </p>
        </motion.div>

        <motion.div variants={cardV} className="glass-card p-5 hover:border-indigo-500/25">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider font-medium">
              Upcoming Deadline
            </span>
            <Calendar className="w-4 h-4 text-indigo-400" />
          </div>
          <p className="text-xl font-bold font-mono text-indigo-300" data-testid="next-due">
            {summary.next_due_date ? formatDate(summary.next_due_date) : 'All Settled'}
          </p>
          <p className="text-xs text-[var(--text-muted)] mt-1 truncate">
            {summary.next_due_invoice
              ? `${summary.next_due_invoice.category} (Rs.${formatCurrency(summary.next_due_invoice.balance_due)})`
              : 'No upcoming dues'}
          </p>
        </motion.div>
      </div>

      {/* Fee Breakdown Bar */}
      {totalBilled > 0 && (
        <motion.div variants={cardV} className="glass-card p-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
            <div>
              <h2 className="text-sm font-semibold font-['Outfit'] text-slate-200">
                Fee Settlement Breakdown
              </h2>
              <p className="text-xs text-[var(--text-muted)]">
                Live balance distribution across paid, partially paid, pending, and overdue invoices
              </p>
            </div>
            <span className="text-xs font-mono text-cyan-300">
              {Math.round(((summary.total_paid || 0) / totalBilled) * 100)}% Settled
            </span>
          </div>

          <div className="h-2.5 w-full rounded-full bg-slate-800/80 overflow-hidden flex">
            {allocationSegments.map((seg) => {
              const widthPct = totalBilled > 0 ? (seg.amount / totalBilled) * 100 : 0;
              if (widthPct <= 0) return null;
              return (
                <div
                  key={seg.key}
                  style={{ width: `${widthPct}%` }}
                  className={`${seg.color} h-full transition-all duration-500`}
                  title={`${seg.label}: Rs.${formatCurrency(seg.amount)}`}
                />
              );
            })}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
            {allocationSegments.map((seg) => (
              <div
                key={seg.key}
                className="flex items-center justify-between px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06]"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-2 h-2 rounded-full ${seg.color} shrink-0`} />
                  <span className="text-xs text-[var(--text-secondary)] truncate">{seg.label}</span>
                </div>
                <span className={`text-xs font-mono font-semibold ${seg.text} ml-2`}>
                  Rs.{formatCurrency(seg.amount)}
                </span>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      {/* Primary Workspace Tabs */}
      <motion.div variants={cardV} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="inline-flex p-1 rounded-xl bg-[var(--surface-1)] border border-[var(--border-subtle)] self-start">
          <button
            type="button"
            onClick={() => setActiveTab('invoices')}
            data-testid="tab-invoices"
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === 'invoices'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-[var(--text-muted)] hover:text-white'
            }`}
          >
            <FileText className="w-4 h-4" />
            Invoices
            <span className="text-xs px-1.5 py-0.5 rounded-md bg-white/10 font-mono">
              {invoices.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('history')}
            data-testid="tab-history"
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === 'history'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-[var(--text-muted)] hover:text-white'
            }`}
          >
            <History className="w-4 h-4" />
            Payment History
            <span className="text-xs px-1.5 py-0.5 rounded-md bg-white/10 font-mono">
              {transactions.length}
            </span>
          </button>
        </div>

        {activeTab === 'invoices' && (
          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 text-[var(--text-muted)] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search invoice # or category..."
              data-testid="invoice-search"
              className="w-full pl-10 pr-4 py-2 rounded-xl bg-[var(--surface-1)] border border-[var(--border-subtle)] text-sm text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500/50"
            />
          </div>
        )}
      </motion.div>

      {/* Tab Content */}
      {activeTab === 'invoices' ? (
        <motion.div variants={cardV} className="space-y-4">
          {/* Status Filter Bar */}
          <div className="flex flex-wrap gap-2">
            {filterTabs.map((tab) => {
              const active = statusFilter === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setStatusFilter(tab.key)}
                  data-testid={`filter-${tab.key.toLowerCase()}`}
                  className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-medium border transition-colors ${
                    active
                      ? 'bg-indigo-500/20 text-indigo-200 border-indigo-400/40'
                      : 'bg-[var(--surface-1)] text-[var(--text-muted)] border-[var(--border-subtle)] hover:text-white hover:border-white/15'
                  }`}
                >
                  <span>{tab.label}</span>
                  <span className="font-mono text-[11px] opacity-80">{tab.count}</span>
                </button>
              );
            })}
          </div>

          {filteredInvoices.length === 0 ? (
            <div className="glass-card p-12 text-center">
              <FileText className="w-10 h-10 text-[var(--text-muted)] mx-auto mb-3 opacity-35" />
              <p className="text-sm font-medium text-slate-300">No matching invoices found</p>
              <p className="text-xs text-[var(--text-muted)] mt-1">
                Try clearing the search query or switching the status filter.
              </p>
            </div>
          ) : (
            <div className="glass-card overflow-hidden">
              {/* Desktop Table */}
              <div className="hidden lg:block overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/[0.08] bg-white/[0.02] text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                      <th className="py-3.5 px-4 font-semibold">Invoice #</th>
                      <th className="py-3.5 px-4 font-semibold">Fee Category</th>
                      <th className="py-3.5 px-4 font-semibold">Issue Date</th>
                      <th className="py-3.5 px-4 font-semibold">Due Date</th>
                      <th className="py-3.5 px-4 font-semibold text-right">Total</th>
                      <th className="py-3.5 px-4 font-semibold text-right">Paid</th>
                      <th className="py-3.5 px-4 font-semibold text-right">Balance</th>
                      <th className="py-3.5 px-4 font-semibold">Status</th>
                      <th className="py-3.5 px-4 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06] text-sm">
                    {filteredInvoices.map((inv) => {
                      const sc = statusConfig[inv.status] || statusConfig.UNPAID;
                      const balance = Number(inv.balance_due ?? Math.max(0, inv.total_amount - inv.amount_paid));
                      return (
                        <tr
                          key={inv.id}
                          data-testid={`invoice-${inv.id}`}
                          className="hover:bg-white/[0.025] transition-colors"
                        >
                          <td className="py-3.5 px-4 font-mono text-xs text-slate-200 whitespace-nowrap">
                            {inv.invoice_number}
                          </td>
                          <td className="py-3.5 px-4">
                            <p className="font-medium text-white">{inv.category}</p>
                            <p className="text-xs text-[var(--text-muted)]">
                              {inv.student_name} · Class {inv.class_name}
                            </p>
                          </td>
                          <td className="py-3.5 px-4 font-mono text-xs text-[var(--text-muted)] whitespace-nowrap">
                            {formatDate(inv.issue_date)}
                          </td>
                          <td className="py-3.5 px-4 font-mono text-xs text-slate-300 whitespace-nowrap">
                            {formatDate(inv.due_date)}
                          </td>
                          <td className="py-3.5 px-4 font-mono text-right text-slate-200 whitespace-nowrap">
                            Rs.{formatCurrency(inv.total_amount)}
                          </td>
                          <td className="py-3.5 px-4 font-mono text-right text-emerald-400 whitespace-nowrap">
                            Rs.{formatCurrency(inv.amount_paid)}
                          </td>
                          <td
                            className={`py-3.5 px-4 font-mono text-right font-semibold whitespace-nowrap ${
                              balance > 0 ? 'text-rose-400' : 'text-slate-400'
                            }`}
                          >
                            Rs.{formatCurrency(balance)}
                          </td>
                          <td className="py-3.5 px-4 whitespace-nowrap">
                            <span
                              className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border font-medium ${sc.bg} ${sc.text} ${sc.border}`}
                            >
                              <span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
                              {sc.label}
                            </span>
                          </td>
                          <td className="py-3.5 px-4 text-right whitespace-nowrap">
                            <div className="inline-flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => openInvoiceDetail(inv)}
                                data-testid={`view-invoice-${inv.id}`}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-xs text-slate-200 border border-[var(--border-subtle)] transition-colors"
                              >
                                <Eye className="w-3.5 h-3.5" />
                                View
                              </button>
                              <button
                                type="button"
                                onClick={() => downloadInvoicePdf(inv)}
                                disabled={downloadingKey === `inv-${inv.id}`}
                                data-testid={`download-pdf-${inv.id}`}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-xs text-slate-200 border border-[var(--border-subtle)] transition-colors disabled:opacity-50"
                                title="Download Invoice PDF"
                              >
                                <Download
                                  className={`w-3.5 h-3.5 ${downloadingKey === `inv-${inv.id}` ? 'animate-spin' : ''}`}
                                />
                                PDF
                              </button>
                              {balance > 0 && (
                                <button
                                  type="button"
                                  onClick={() => openCheckoutModal(inv)}
                                  data-testid={`pay-now-${inv.id}`}
                                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white transition-colors"
                                >
                                  <CreditCard className="w-3.5 h-3.5" />
                                  Pay
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile / Tablet Cards */}
              <div className="lg:hidden divide-y divide-white/[0.06]">
                {filteredInvoices.map((inv) => {
                  const sc = statusConfig[inv.status] || statusConfig.UNPAID;
                  const StatusIcon = sc.icon;
                  const balance = Number(inv.balance_due ?? Math.max(0, inv.total_amount - inv.amount_paid));
                  return (
                    <div key={inv.id} className="p-4 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={`w-9 h-9 rounded-xl ${sc.bg} flex items-center justify-center shrink-0`}>
                            <StatusIcon className={`w-4 h-4 ${sc.text}`} />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-white truncate">{inv.category}</p>
                            <p className="text-xs font-mono text-[var(--text-muted)]">{inv.invoice_number}</p>
                          </div>
                        </div>
                        <span
                          className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-lg border font-medium shrink-0 ${sc.bg} ${sc.text} ${sc.border}`}
                        >
                          {sc.label}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-xs bg-white/[0.02] p-3 rounded-xl border border-white/[0.05]">
                        <div>
                          <span className="text-[var(--text-muted)]">Issued:</span>{' '}
                          <span className="font-mono text-slate-200">{formatDate(inv.issue_date)}</span>
                        </div>
                        <div>
                          <span className="text-[var(--text-muted)]">Due:</span>{' '}
                          <span className="font-mono text-slate-200">{formatDate(inv.due_date)}</span>
                        </div>
                        <div>
                          <span className="text-[var(--text-muted)]">Total:</span>{' '}
                          <span className="font-mono text-slate-200">Rs.{formatCurrency(inv.total_amount)}</span>
                        </div>
                        <div>
                          <span className="text-[var(--text-muted)]">Paid:</span>{' '}
                          <span className="font-mono text-emerald-400">Rs.{formatCurrency(inv.amount_paid)}</span>
                        </div>
                        <div className="col-span-2 pt-1 border-t border-white/[0.05] flex justify-between">
                          <span className="text-[var(--text-muted)]">Remaining Balance:</span>
                          <span className={`font-mono font-bold ${balance > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                            Rs.{formatCurrency(balance)}
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => openInvoiceDetail(inv)}
                          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-[var(--surface-2)] text-xs font-medium border border-[var(--border-subtle)]"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          Details
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadInvoicePdf(inv)}
                          disabled={downloadingKey === `inv-${inv.id}`}
                          className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-[var(--surface-2)] text-xs font-medium border border-[var(--border-subtle)]"
                        >
                          <Download className="w-3.5 h-3.5" />
                          PDF
                        </button>
                        {balance > 0 && (
                          <button
                            type="button"
                            onClick={() => openCheckoutModal(inv)}
                            className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-indigo-600 text-xs font-semibold text-white"
                          >
                            <CreditCard className="w-3.5 h-3.5" />
                            Pay Now
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </motion.div>
      ) : (
        /* Payment History Tab */
        <motion.div variants={cardV} className="space-y-4">
          {transactions.length === 0 ? (
            <div className="glass-card p-12 text-center">
              <Receipt className="w-10 h-10 text-[var(--text-muted)] mx-auto mb-3 opacity-35" />
              <p className="text-sm font-medium text-slate-300">No payment transactions yet</p>
              <p className="text-xs text-[var(--text-muted)] mt-1">
                Completed demonstration fee payments will appear here with downloadable receipts.
              </p>
            </div>
          ) : (
            <div className="glass-card overflow-hidden">
              <div className="hidden lg:block overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/[0.08] bg-white/[0.02] text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                      <th className="py-3.5 px-4 font-semibold">Reference #</th>
                      <th className="py-3.5 px-4 font-semibold">Receipt #</th>
                      <th className="py-3.5 px-4 font-semibold">Invoice</th>
                      <th className="py-3.5 px-4 font-semibold">Payment Date</th>
                      <th className="py-3.5 px-4 font-semibold">Method</th>
                      <th className="py-3.5 px-4 font-semibold text-right">Amount</th>
                      <th className="py-3.5 px-4 font-semibold">Demo Status</th>
                      <th className="py-3.5 px-4 font-semibold text-right">Receipt</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06] text-sm">
                    {transactions.map((txn) => (
                      <tr key={txn.id} data-testid={`transaction-${txn.id}`} className="hover:bg-white/[0.025]">
                        <td className="py-3.5 px-4 font-mono text-xs text-slate-200 whitespace-nowrap">
                          {txn.reference_number}
                        </td>
                        <td className="py-3.5 px-4 font-mono text-xs text-cyan-300 whitespace-nowrap">
                          {txn.receipt_number}
                        </td>
                        <td className="py-3.5 px-4">
                          <p className="font-medium text-white">{txn.invoice_category}</p>
                          <p className="text-xs font-mono text-[var(--text-muted)]">{txn.invoice_number}</p>
                        </td>
                        <td className="py-3.5 px-4 text-xs text-slate-300 whitespace-nowrap">
                          {formatDateTime(txn.paid_at || txn.created_at)}
                        </td>
                        <td className="py-3.5 px-4">
                          <p className="text-xs font-medium text-slate-200">
                            {formatMethodLabel(txn.payment_method)}
                          </p>
                          <p className="text-[11px] text-[var(--text-muted)]">{txn.method_detail}</p>
                        </td>
                        <td className="py-3.5 px-4 font-mono text-right font-semibold text-emerald-400 whitespace-nowrap">
                          Rs.{formatCurrency(txn.amount)}
                        </td>
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-emerald-500/12 text-emerald-300 border border-emerald-500/25 font-medium">
                            <CheckCircle className="w-3.5 h-3.5" />
                            Demo · {txn.status}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => downloadReceiptPdf(txn)}
                            disabled={downloadingKey === `rcpt-${txn.id}`}
                            data-testid={`download-receipt-${txn.id}`}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-xs font-medium text-slate-100 border border-[var(--border-subtle)] transition-colors disabled:opacity-50"
                          >
                            <Download
                              className={`w-3.5 h-3.5 ${downloadingKey === `rcpt-${txn.id}` ? 'animate-spin' : ''}`}
                            />
                            Receipt PDF
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="lg:hidden divide-y divide-white/[0.06]">
                {transactions.map((txn) => (
                  <div key={txn.id} className="p-4 space-y-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-white">{txn.invoice_category}</p>
                        <p className="text-xs font-mono text-cyan-300">{txn.receipt_number}</p>
                      </div>
                      <span className="text-sm font-mono font-bold text-emerald-400">
                        Rs.{formatCurrency(txn.amount)}
                      </span>
                    </div>
                    <div className="text-xs text-[var(--text-muted)] space-y-1">
                      <p>Ref: <span className="font-mono text-slate-300">{txn.reference_number}</span></p>
                      <p>Invoice: <span className="font-mono text-slate-300">{txn.invoice_number}</span> · {formatMethodLabel(txn.payment_method)}</p>
                      <p>Date: {formatDateTime(txn.paid_at || txn.created_at)}</p>
                    </div>
                    <div className="flex items-center justify-between pt-1">
                      <span className="text-[11px] px-2 py-0.5 rounded-lg bg-emerald-500/12 text-emerald-300 border border-emerald-500/25">
                        Demo · {txn.status}
                      </span>
                      <button
                        type="button"
                        onClick={() => downloadReceiptPdf(txn)}
                        disabled={downloadingKey === `rcpt-${txn.id}`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[var(--surface-2)] text-xs font-medium border border-[var(--border-subtle)]"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Receipt PDF
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </motion.div>
      )}

      {/* Detailed Invoice Modal */}
      <AnimatePresence>
        {detailInvoice && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
            onClick={() => setDetailInvoice(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 12 }}
              onClick={(e) => e.stopPropagation()}
              data-testid="invoice-detail-modal"
              className="w-full max-w-2xl rounded-2xl bg-[#0f1628] border border-white/[0.12] shadow-2xl overflow-hidden my-auto"
            >
              {/* School Identity Header */}
              <div className="p-6 bg-gradient-to-r from-indigo-950/70 via-[#121c36] to-slate-900 border-b border-white/[0.08] flex items-start justify-between gap-4">
                <div className="flex items-center gap-3.5">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-cyan-400 flex items-center justify-center shadow-lg shrink-0">
                    <GraduationCap className="w-6 h-6 text-white" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold font-['Outfit'] text-white">
                      {schoolIdentity.name}
                    </h2>
                    <p className="text-xs text-slate-300">{schoolIdentity.department}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      {schoolIdentity.address} · {schoolIdentity.email} · {schoolIdentity.phone}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setDetailInvoice(null)}
                  aria-label="Close invoice details"
                  className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.08] transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-6 space-y-5 max-h-[75vh] overflow-y-auto">
                {/* Student & Invoice Metadata */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="p-4 rounded-xl bg-white/[0.03] border border-white/[0.07] space-y-1">
                    <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-semibold">
                      Student Details
                    </p>
                    <p className="text-sm font-semibold text-white">{detailInvoice.student_name}</p>
                    <p className="text-xs text-slate-300">
                      Class: <span className="font-mono">{detailInvoice.class_name || 'N/A'}</span> · Roll #:{' '}
                      <span className="font-mono">{detailInvoice.roll_number || 'N/A'}</span>
                    </p>
                    <p className="text-xs text-[var(--text-muted)]">Category: {detailInvoice.category}</p>
                  </div>

                  <div className="p-4 rounded-xl bg-white/[0.03] border border-white/[0.07] space-y-1">
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-semibold">
                        Invoice Summary
                      </p>
                      {(() => {
                        const sc = statusConfig[detailInvoice.status] || statusConfig.UNPAID;
                        return (
                          <span className={`text-[11px] px-2 py-0.5 rounded-md border ${sc.bg} ${sc.text} ${sc.border}`}>
                            {sc.label}
                          </span>
                        );
                      })()}
                    </div>
                    <p className="text-sm font-mono font-bold text-white">{detailInvoice.invoice_number}</p>
                    <p className="text-xs text-slate-300">
                      Issue Date: <span className="font-mono">{formatDate(detailInvoice.issue_date)}</span>
                    </p>
                    <p className="text-xs text-slate-300">
                      Due Date: <span className="font-mono">{formatDate(detailInvoice.due_date)}</span>
                    </p>
                  </div>
                </div>

                {/* Itemised Breakdown */}
                <div className="rounded-xl border border-white/[0.08] overflow-hidden">
                  <table className="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr className="bg-white/[0.04] text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                        <th className="py-2.5 px-4 font-semibold">Fee Item</th>
                        <th className="py-2.5 px-4 font-semibold text-right">Base Fee</th>
                        <th className="py-2.5 px-4 font-semibold text-right">GST</th>
                        <th className="py-2.5 px-4 font-semibold text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.06]">
                      {(detailInvoice.line_items || []).map((item, idx) => {
                        const gst = Number(item.gst_amount || 0);
                        const base = Number(item.amount || 0);
                        return (
                          <tr key={`${item.label}-${idx}`}>
                            <td className="py-2.5 px-4 text-slate-200">{item.label}</td>
                            <td className="py-2.5 px-4 font-mono text-right text-slate-300">
                              Rs.{formatCurrency(base)}
                            </td>
                            <td className="py-2.5 px-4 font-mono text-right text-slate-400">
                              Rs.{formatCurrency(gst)}
                            </td>
                            <td className="py-2.5 px-4 font-mono text-right font-medium text-white">
                              Rs.{formatCurrency(base + gst)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Totals Block */}
                <div className="p-4 rounded-xl bg-white/[0.03] border border-white/[0.08] space-y-2 text-sm">
                  <div className="flex justify-between text-slate-300">
                    <span>Subtotal</span>
                    <span className="font-mono">Rs.{formatCurrency(detailInvoice.subtotal)}</span>
                  </div>
                  <div className="flex justify-between text-slate-400 text-xs">
                    <span>CGST</span>
                    <span className="font-mono">Rs.{formatCurrency(detailInvoice.cgst)}</span>
                  </div>
                  <div className="flex justify-between text-slate-400 text-xs">
                    <span>SGST</span>
                    <span className="font-mono">Rs.{formatCurrency(detailInvoice.sgst)}</span>
                  </div>
                  <div className="flex justify-between text-white font-semibold pt-2 border-t border-white/[0.07]">
                    <span>Total Amount</span>
                    <span className="font-mono">Rs.{formatCurrency(detailInvoice.total_amount)}</span>
                  </div>
                  <div className="flex justify-between text-emerald-400">
                    <span>Amount Already Paid</span>
                    <span className="font-mono">Rs.{formatCurrency(detailInvoice.amount_paid)}</span>
                  </div>
                  <div className="flex justify-between text-base font-bold pt-2 border-t border-white/[0.07]">
                    <span>Outstanding Balance</span>
                    <span
                      className={`font-mono ${
                        (detailInvoice.balance_due ?? detailInvoice.total_amount - detailInvoice.amount_paid) > 0
                          ? 'text-rose-400'
                          : 'text-emerald-400'
                      }`}
                    >
                      Rs.
                      {formatCurrency(
                        detailInvoice.balance_due ??
                          Math.max(0, detailInvoice.total_amount - detailInvoice.amount_paid)
                      )}
                    </span>
                  </div>
                </div>

                {/* Linked Demo Receipts */}
                {Array.isArray(detailInvoice.transactions) && detailInvoice.transactions.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                      Receipts Issued
                    </p>
                    {detailInvoice.transactions.map((txn) => (
                      <div
                        key={txn.id}
                        className="flex items-center justify-between gap-3 p-3 rounded-xl bg-emerald-500/8 border border-emerald-500/20 text-xs"
                      >
                        <div>
                          <p className="font-mono font-semibold text-emerald-300">{txn.receipt_number}</p>
                          <p className="text-slate-300">
                            Rs.{formatCurrency(txn.amount)} via {formatMethodLabel(txn.payment_method)} ·{' '}
                            {formatDate(txn.paid_at)}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => downloadReceiptPdf(txn)}
                          disabled={downloadingKey === `rcpt-${txn.id}`}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 font-medium transition-colors"
                        >
                          <Download className="w-3.5 h-3.5" />
                          Receipt PDF
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Footer Actions */}
              <div className="p-5 bg-white/[0.02] border-t border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => downloadInvoicePdf(detailInvoice)}
                  disabled={downloadingKey === `inv-${detailInvoice.id}`}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-sm font-medium text-white border border-[var(--border-subtle)] transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Download Invoice PDF
                </button>

                {(detailInvoice.balance_due ?? detailInvoice.total_amount - detailInvoice.amount_paid) > 0 && (
                  <button
                    type="button"
                    onClick={() => openCheckoutModal(detailInvoice)}
                    data-testid="modal-pay-now"
                    className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-sm font-semibold text-white shadow-[0_0_24px_rgba(99,102,241,0.35)] transition-colors"
                  >
                    <CreditCard className="w-4 h-4" />
                    Proceed to Pay
                    <ArrowRight className="w-4 h-4" />
                  </button>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Step-by-Step Demo Payment Checkout Modal */}
      <AnimatePresence>
        {checkoutInvoice && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
            onClick={closeCheckoutModal}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 12 }}
              onClick={(e) => e.stopPropagation()}
              data-testid="demo-checkout-modal"
              className="w-full max-w-lg rounded-2xl bg-[#0f1628] border border-white/[0.12] shadow-2xl overflow-hidden my-auto"
            >
              {/* Modal Top Bar */}
              <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold font-['Outfit'] text-white">
                    {checkoutStep === 'success' ? 'Demo Payment Confirmed' : 'The Oxford School Fee Checkout'}
                  </h2>
                  <p className="text-xs text-[var(--text-muted)] font-mono">
                    {checkoutInvoice.invoice_number} · {checkoutInvoice.category}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closeCheckoutModal}
                  disabled={submittingPayment}
                  aria-label="Close checkout"
                  className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/[0.08]"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Mandatory Demonstration Notice */}
              <div className="px-6 py-2.5 bg-indigo-500/12 border-b border-indigo-400/20 flex items-center gap-2 text-xs text-indigo-200">
                <ShieldCheck className="w-4 h-4 text-cyan-400 shrink-0" />
                <span>Exhibition Demonstration — No real money will be charged.</span>
              </div>

              <div className="p-6 space-y-5">
                {checkoutStep === 'review' && (
                  <>
                    {/* Step 1: Fee Breakdown & Payable Amount */}
                    <div className="space-y-3">
                      <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300">
                        Step 1 of 2 · Review Fee Breakdown
                      </p>

                      <div className="rounded-xl bg-white/[0.03] border border-white/[0.08] p-4 space-y-2 text-sm">
                        {(checkoutInvoice.line_items || []).map((item, idx) => (
                          <div key={`${item.label}-${idx}`} className="flex justify-between text-xs text-slate-300">
                            <span>{item.label}</span>
                            <span className="font-mono">
                              Rs.{formatCurrency((item.amount || 0) + (item.gst_amount || 0))}
                            </span>
                          </div>
                        ))}
                        <div className="pt-2 border-t border-white/[0.07] flex justify-between text-xs text-slate-400">
                          <span>Total Invoice</span>
                          <span className="font-mono">Rs.{formatCurrency(checkoutInvoice.total_amount)}</span>
                        </div>
                        <div className="flex justify-between text-xs text-emerald-400">
                          <span>Already Paid</span>
                          <span className="font-mono">Rs.{formatCurrency(checkoutInvoice.amount_paid)}</span>
                        </div>
                        <div className="flex justify-between text-base font-bold text-white pt-2 border-t border-white/[0.07]">
                          <span>Exact Payable Balance</span>
                          <span className="font-mono text-cyan-300">
                            Rs.
                            {formatCurrency(
                              checkoutInvoice.balance_due ??
                                Math.max(0, checkoutInvoice.total_amount - checkoutInvoice.amount_paid)
                            )}
                          </span>
                        </div>
                      </div>

                      {/* Full vs Partial Amount Choice */}
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-slate-300 block">
                          Payment Amount Option
                        </label>
                        <div className="grid grid-cols-2 gap-2.5">
                          <button
                            type="button"
                            onClick={() => setPaymentMode('FULL')}
                            className={`p-3 rounded-xl border text-left text-xs transition-colors ${
                              paymentMode === 'FULL'
                                ? 'bg-indigo-500/18 border-indigo-400/50 text-white'
                                : 'bg-white/[0.02] border-white/[0.08] text-slate-300 hover:border-white/20'
                            }`}
                          >
                            <p className="font-semibold">Pay Full Balance</p>
                            <p className="font-mono text-cyan-300 mt-0.5">
                              Rs.
                              {formatCurrency(
                                checkoutInvoice.balance_due ??
                                  Math.max(0, checkoutInvoice.total_amount - checkoutInvoice.amount_paid)
                              )}
                            </p>
                          </button>
                          <button
                            type="button"
                            onClick={() => setPaymentMode('PARTIAL')}
                            className={`p-3 rounded-xl border text-left text-xs transition-colors ${
                              paymentMode === 'PARTIAL'
                                ? 'bg-indigo-500/18 border-indigo-400/50 text-white'
                                : 'bg-white/[0.02] border-white/[0.08] text-slate-300 hover:border-white/20'
                            }`}
                          >
                            <p className="font-semibold">Custom Installment</p>
                            <p className="text-[var(--text-muted)] mt-0.5">Pay a partial amount</p>
                          </button>
                        </div>

                        {paymentMode === 'PARTIAL' && (
                          <div className="pt-1">
                            <div className="relative">
                              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-xs font-mono text-slate-400">
                                Rs.
                              </span>
                              <input
                                type="number"
                                min="1"
                                max={
                                  checkoutInvoice.balance_due ??
                                  Math.max(0, checkoutInvoice.total_amount - checkoutInvoice.amount_paid)
                                }
                                step="1"
                                value={customAmount}
                                onChange={(e) => setCustomAmount(e.target.value)}
                                data-testid="custom-payment-amount"
                                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[var(--surface-1)] border border-white/[0.12] text-sm font-mono text-white focus:outline-none focus:border-indigo-500"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex justify-end gap-3 pt-2">
                      <button
                        type="button"
                        onClick={closeCheckoutModal}
                        className="px-4 py-2.5 rounded-xl bg-[var(--surface-2)] text-xs font-medium text-slate-300"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const balance = Number(
                            checkoutInvoice.balance_due ??
                              Math.max(0, checkoutInvoice.total_amount - checkoutInvoice.amount_paid)
                          );
                          if (!Number.isFinite(payableAmount) || payableAmount <= 0 || payableAmount > balance) {
                            toast.error(`Amount must be between Rs.1 and Rs.${formatCurrency(balance)}.`);
                            return;
                          }
                          setCheckoutStep('method');
                        }}
                        data-testid="checkout-continue-btn"
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white"
                      >
                        Continue to Demo Method
                        <ArrowRight className="w-4 h-4" />
                      </button>
                    </div>
                  </>
                )}

                {checkoutStep === 'method' && (
                  <>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold uppercase tracking-wider text-cyan-300">
                          Step 2 of 2 · Select Demo Payment Method
                        </p>
                        <span className="text-sm font-mono font-bold text-white">
                          Rs.{formatCurrency(payableAmount)}
                        </span>
                      </div>

                      <div className="space-y-2.5">
                        {DEMO_METHODS.map((method) => {
                          const Icon = method.icon;
                          const selected = paymentMethod === method.id;
                          return (
                            <button
                              key={method.id}
                              type="button"
                              onClick={() => handleMethodSelect(method.id)}
                              data-testid={`demo-method-${method.id.toLowerCase()}`}
                              className={`w-full flex items-center gap-3.5 p-3.5 rounded-xl border text-left transition-all ${
                                selected
                                  ? 'bg-indigo-500/18 border-indigo-400/50 shadow-[0_0_16px_rgba(99,102,241,0.18)]'
                                  : 'bg-white/[0.02] border-white/[0.08] hover:border-white/20'
                              }`}
                            >
                              <div className="w-10 h-10 rounded-xl bg-white/[0.05] flex items-center justify-center shrink-0">
                                <Icon className={`w-5 h-5 ${method.accent}`} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold text-white">{method.label}</p>
                                <p className="text-xs text-[var(--text-muted)]">{method.subtitle}</p>
                              </div>
                              <div
                                className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                                  selected ? 'border-indigo-400' : 'border-slate-600'
                                }`}
                              >
                                {selected && <div className="w-2 h-2 rounded-full bg-indigo-400" />}
                              </div>
                            </button>
                          );
                        })}
                      </div>

                      {/* Safe Simulated Instrument Selector */}
                      <div className="p-3.5 rounded-xl bg-white/[0.03] border border-white/[0.08] space-y-2">
                        <label className="text-xs font-medium text-slate-300 block">
                          {paymentMethod === 'UPI'
                            ? 'Demo UPI Handle'
                            : paymentMethod === 'CARD'
                              ? 'Simulated Test Card'
                              : 'Simulated Demo Bank'}
                        </label>
                        {paymentMethod === 'UPI' ? (
                          <input
                            type="text"
                            value={methodDetail}
                            onChange={(e) => setMethodDetail(e.target.value)}
                            maxLength={60}
                            placeholder="student@demoupi"
                            className="w-full px-3 py-2 rounded-lg bg-[var(--surface-1)] border border-white/[0.1] text-xs font-mono text-white focus:outline-none focus:border-indigo-500"
                          />
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {(DEMO_METHODS.find((m) => m.id === paymentMethod)?.presets || []).map((preset) => (
                              <button
                                key={preset}
                                type="button"
                                onClick={() => setMethodDetail(preset)}
                                className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                                  methodDetail === preset
                                    ? 'bg-cyan-500/15 border-cyan-400/40 text-cyan-200'
                                    : 'bg-[var(--surface-1)] border-white/[0.08] text-slate-300'
                                }`}
                              >
                                {preset}
                              </button>
                            ))}
                          </div>
                        )}
                        <p className="text-[11px] text-[var(--text-muted)]">
                          Simulated demo instrument only — never enter real banking credentials or card PINs.
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 pt-2">
                      <button
                        type="button"
                        onClick={() => setCheckoutStep('review')}
                        disabled={submittingPayment}
                        className="px-4 py-2.5 rounded-xl bg-[var(--surface-2)] text-xs font-medium text-slate-300"
                      >
                        Back
                      </button>
                      <button
                        type="button"
                        onClick={handleConfirmDemoPayment}
                        disabled={submittingPayment}
                        data-testid="confirm-demo-payment-btn"
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-xs font-semibold text-white shadow-[0_0_24px_rgba(16,185,129,0.28)]"
                      >
                        <CheckCircle className="w-4 h-4" />
                        {submittingPayment
                          ? 'Recording Demo Payment...'
                          : `Confirm Demo Payment (Rs.${formatCurrency(payableAmount)})`}
                      </button>
                    </div>
                  </>
                )}

                {checkoutStep === 'success' && confirmedResult?.transaction && (
                  <div className="space-y-4 text-center" data-testid="demo-payment-success">
                    <div className="w-14 h-14 rounded-2xl bg-emerald-500/15 border border-emerald-400/30 flex items-center justify-center mx-auto">
                      <CheckCircle className="w-7 h-7 text-emerald-400" />
                    </div>
                    <div>
                      <h3 className="text-lg font-bold font-['Outfit'] text-white">
                        Payment Recorded Successfully
                      </h3>
                      <p className="text-xs text-[var(--text-muted)] mt-1">
                        Exhibition Demonstration — No real money was charged.
                      </p>
                    </div>

                    <div className="p-4 rounded-xl bg-white/[0.03] border border-white/[0.08] text-left text-xs space-y-2">
                      <div className="flex justify-between">
                        <span className="text-[var(--text-muted)]">Receipt Number</span>
                        <span className="font-mono font-semibold text-cyan-300">
                          {confirmedResult.transaction.receipt_number}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[var(--text-muted)]">Reference ID</span>
                        <span className="font-mono text-slate-200">
                          {confirmedResult.transaction.reference_number}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[var(--text-muted)]">Demo Method</span>
                        <span className="text-slate-200">
                          {formatMethodLabel(confirmedResult.transaction.payment_method)} (
                          {confirmedResult.transaction.method_detail})
                        </span>
                      </div>
                      <div className="flex justify-between pt-2 border-t border-white/[0.07]">
                        <span className="text-slate-300 font-medium">Amount Paid</span>
                        <span className="font-mono font-bold text-emerald-400">
                          Rs.{formatCurrency(confirmedResult.transaction.amount)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[var(--text-muted)]">Updated Balance</span>
                        <span className="font-mono text-white">
                          Rs.{formatCurrency(confirmedResult.transaction.balance_after)}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-col sm:flex-row gap-3 pt-1">
                      <button
                        type="button"
                        onClick={() => downloadReceiptPdf(confirmedResult.transaction)}
                        disabled={downloadingKey === `rcpt-${confirmedResult.transaction.id}`}
                        data-testid="download-confirmed-receipt"
                        className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white"
                      >
                        <Download className="w-4 h-4" />
                        Download Receipt PDF
                      </button>
                      <button
                        type="button"
                        onClick={closeCheckoutModal}
                        className="px-5 py-2.5 rounded-xl bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-xs font-medium text-slate-200 border border-[var(--border-subtle)]"
                      >
                        Done
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function PaymentsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-12 w-72 rounded-xl bg-[var(--surface-1)] shimmer-bg" />
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="glass-card shimmer-bg h-28 rounded-2xl" />
        ))}
      </div>
      <div className="glass-card shimmer-bg h-28 rounded-2xl" />
      <div className="space-y-3">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="glass-card shimmer-bg h-16 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
