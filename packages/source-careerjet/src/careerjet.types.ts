export interface CareerJetResponse {
  type: string;
  hits: number;
  pages: number;
  response_time: number;
  jobs: CareerJetJob[];
}

export interface CareerJetJob {
  title: string;
  company: string;
  date: string;
  description: string;
  locations: string;
  url: string;
  site: string;
  salary: string;
  salary_min: number;
  salary_max: number;
  /** Y=yearly, M=monthly, W=weekly, D=daily, H=hourly */
  salary_type: string;
  salary_currency_code: string;
}
