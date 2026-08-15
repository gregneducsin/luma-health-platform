import { Route, Switch } from "wouter";
import { LoginPage } from "./pages/LoginPage";
import { AcceptInvitationPage } from "./pages/AcceptInvitationPage";
import { DashboardPage } from "./pages/DashboardPage";
import { LeadsPage } from "./pages/LeadsPage";
import { OrdersPage } from "./pages/OrdersPage";
import { CustomerDetailPage } from "./pages/CustomerDetailPage";
import { PayrollEmployeesPage } from "./pages/PayrollEmployeesPage";
import { PayrollWeeksPage } from "./pages/PayrollWeeksPage";
import { PayrollWeekDetailPage } from "./pages/PayrollWeekDetailPage";
import { MarketingCpaPage } from "./pages/MarketingCpaPage";
import { QuestionnairesPage } from "./pages/QuestionnairesPage";
import { ProtectedRoute } from "./components/ProtectedRoute";

export default function App() {
  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/accept-invitation" component={AcceptInvitationPage} />

      <Route path="/">
        <ProtectedRoute>
          <DashboardPage />
        </ProtectedRoute>
      </Route>

      <Route path="/customers">
        <ProtectedRoute>
          <LeadsPage />
        </ProtectedRoute>
      </Route>

      <Route path="/customers/:id">
        <ProtectedRoute>
          <CustomerDetailPage />
        </ProtectedRoute>
      </Route>

      <Route path="/orders">
        <ProtectedRoute>
          <OrdersPage />
        </ProtectedRoute>
      </Route>

      <Route path="/payroll/employees">
        <ProtectedRoute>
          <PayrollEmployeesPage />
        </ProtectedRoute>
      </Route>

      <Route path="/payroll/weeks">
        <ProtectedRoute>
          <PayrollWeeksPage />
        </ProtectedRoute>
      </Route>

      <Route path="/payroll/weeks/:id">
        <ProtectedRoute>
          <PayrollWeekDetailPage />
        </ProtectedRoute>
      </Route>

      <Route path="/marketing-cpa">
        <ProtectedRoute>
          <MarketingCpaPage />
        </ProtectedRoute>
      </Route>

      <Route path="/questionnaires">
        <ProtectedRoute>
          <QuestionnairesPage />
        </ProtectedRoute>
      </Route>

      <Route>
        <div className="flex min-h-screen items-center justify-center text-sm text-gray-500">Page not found.</div>
      </Route>
    </Switch>
  );
}
