import Page from "./Page"
import Breadcrumbs from "../Breadcrumbs"
import "./DetailPage.scss"
import DropDown from "../DropDown"

export default ({ breadcrumbs, title, subtitle, menu, children }) => (
  <Page title={title}>
    {title && <div className="detail-page-title">
      <h1 className="no-margin-bottom">{title}</h1>{menu && <DropDown title="Actions">{menu}</DropDown>}
    </div>}
    {subtitle && <p className="detail-page-subtitle">{subtitle}</p>}
    {breadcrumbs && <Breadcrumbs breadcrumbs={breadcrumbs} />}
    {(title || subtitle) && <hr className="detail-page-divider" />}
    <div className="detail-page-main">
      {children}
    </div>
  </Page>
)
