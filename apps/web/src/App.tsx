import { Route, Switch } from "wouter";
import { LoginPage } from "./pages/LoginPage";
import { AcceptInvitationPage } from "./pages/AcceptInvitationPage";
import { DashboardPage } from "./pages/DashboardPage";
import { CustomersListPage } from "./pages/CustomersListPage";
import { CustomerDetailPage } from "./pages/CustomerDetailPage";
import { PayrollEmployeesPage } from "./pages/PayrollEmployeesPage";
import { PayrollWeeksPage } from "./pages/PayrollWeeksPage";
import { PayrollWeekDetailPage } from "./pages/PayrollWeekDetailPage";
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
          <CustomersListPage />
        </ProtectedRoute>
      </Route>

      <Route path="/customers/:id">
        <ProtectedRoute>
          <CustomerDetailPage />
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

      <Route>
        <div className="flex min-h-screen items-center justify-center text-sm text-gray-500">Page not found.</div>
      </Route>
    </Switch>
  );
}
